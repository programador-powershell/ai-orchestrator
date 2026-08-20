/**
 * O estado compartilhado da tela de Código: o rail (árvore) e a superfície
 * (abas, editor, salvar) leem os DOIS lados do mesmo store de módulo — o mesmo
 * desenho do useCode do orquestrador, porque o problema é o mesmo: clicar num
 * arquivo do rail tem de abrir a aba do centro, e props não atravessam o shell.
 *
 * Regras que este arquivo protege:
 *
 * - A ÁRVORE É REAL OU NÃO É. Tudo vem de fs.list/fs.read pela rota
 *   /v1/tools/call; falha vira mensagem (`erro`) no lugar exato onde a pasta
 *   apareceria. Nunca uma árvore inventada — a regra da casa dos rails.
 *
 * - TUDO É POR SESSÃO. O projeto é o workspace da sessão do gateway; trocar de
 *   conversa troca de projeto, então árvore, abas e índice morrem juntos
 *   (`sincronizarSessao`). Resposta que chega DEPOIS da troca é descartada —
 *   sem isso, a listagem em voo da conversa antiga pintava a árvore da nova.
 *
 * - SALVAR É GRAVAÇÃO DE VERDADE (fs.write), com o portão de aprovação do
 *   gateway no meio: o POST fica pendurado enquanto o cartão espera decisão, e
 *   a recusa volta como motivo em português — nunca como exceção.
 */

import { create } from "zustand";
import { chamarFerramenta } from "./ferramentas";
import {
  coletarArquivos,
  nomeBase,
  parseBusca,
  parseListagem,
  type EntradaProjeto,
  type OcorrenciaBusca
} from "./projeto";

export interface ArquivoAberto {
  path: string;
  name: string;
  content: string;
  /** Último conteúdo confirmado em disco — a base contra a qual se mede sujeira. */
  savedContent: string;
  dirty: boolean;
  loading: boolean;
  /**
   * Motivo pelo qual este buffer NÃO é confiável (leitura falhou, arquivo
   * cortado pelo teto do gateway). Com `erro` preenchido a edição e o salvar
   * ficam bloqueados: gravar um buffer truncado de volta APAGARIA o resto do
   * arquivo real — o bloqueio é proteção de dado, não frescura de UI.
   */
  erro: string;
}

export interface Pasta {
  entradas: EntradaProjeto[];
  /** "" quando a listagem deu certo; senão, o motivo que a árvore mostra. */
  erro: string;
}

export type EstadoSalvar = "parado" | "salvando" | "salvo" | "erro";

export interface IdeData {
  /** Sessão dona da árvore e das abas — o carimbo que invalida resposta velha. */
  session: string;
  tree: Record<string, Pasta>;
  expanded: ReadonlySet<string>;
  files: ArquivoAberto[];
  activePath: string;
  saveState: EstadoSalvar;
  saveErro: string;
  /**
   * Caminho que o BOT gravou no disco enquanto a aba dele estava SUJA aqui.
   *
   * O rascunho local da pessoa VENCE (regra do abrirVindoDaConversa), então o
   * buffer não é recarregado — mas ficar calado seria pior: ela salvaria por
   * cima do trabalho do bot sem saber que ele existiu. O chip discreto conta.
   * Some quando a pessoa salva (a versão dela venceu de vez), fecha a aba ou
   * troca de sessão. "" = sem aviso.
   */
  avisoDoBot: string;
}

export function estadoInicialIde(): IdeData {
  return {
    session: "",
    tree: {},
    expanded: new Set<string>(),
    files: [],
    activePath: "",
    saveState: "parado",
    saveErro: "",
    avisoDoBot: ""
  };
}

export const useIde = create<IdeData>()(() => estadoInicialIde());

/** Teto do índice do Quick Open — cada nível de pasta é um POST no gateway. */
export const TETO_INDICE = { maxEntries: 500, maxDepth: 4 } as const;

/** Cache do índice (Quick Open) — por sessão; morre em refresh e troca de sessão. */
let indice: EntradaProjeto[] | null = null;
let indiceEmVoo: Promise<EntradaProjeto[]> | null = null;
/** Trava da primeira carga da raiz: rail e superfície chamam, só a primeira ganha. */
let raizEmVoo = false;
/** O timer do debounce da atualização em lugar — ver agendarAtualizacaoDaArvore. */
let atualizacaoAgendada = 0;
/** O timer da abertura ao vivo e o alvo dela — ver agendarAberturaDoBot. */
let aberturaAgendada = 0;
let aberturaAlvo = "";

/** Cancela a atualização agendada — a sessão trocou e ela era da anterior. */
function cancelarAtualizacaoAgendada(): void {
  if (atualizacaoAgendada !== 0) window.clearTimeout(atualizacaoAgendada);
  atualizacaoAgendada = 0;
}

/** Cancela a abertura ao vivo pendente — o arquivo era do projeto anterior. */
function cancelarAberturaAgendada(): void {
  if (aberturaAgendada !== 0) window.clearTimeout(aberturaAgendada);
  aberturaAgendada = 0;
  aberturaAlvo = "";
}

/**
 * Adota a sessão nova zerando o que era da anterior. Idempotente de propósito:
 * rail e superfície montam em ordens diferentes e os dois chamam — a segunda
 * chamada com a mesma sessão não pode apagar a árvore que a primeira carregou.
 */
export function sincronizarSessao(session: string): void {
  if (useIde.getState().session === session) return;
  indice = null;
  indiceEmVoo = null;
  raizEmVoo = false;
  cancelarAtualizacaoAgendada();
  cancelarAberturaAgendada();
  useIde.setState({ ...estadoInicialIde(), session });
}

/** Zera TUDO, cache de módulo incluso — para os testes partirem limpos. */
export function zerarIde(): void {
  indice = null;
  indiceEmVoo = null;
  raizEmVoo = false;
  cancelarAtualizacaoAgendada();
  cancelarAberturaAgendada();
  useIde.setState({ ...estadoInicialIde() });
}

/** fs.list traduzida: erro do gateway vira exceção com o motivo em português. */
async function listarPasta(sub: string): Promise<EntradaProjeto[]> {
  const resultado = await chamarFerramenta("fs.list", { path: sub });
  if (!resultado.ok) throw new Error(resultado.error);
  return parseListagem(resultado.output, sub);
}

export async function carregarPasta(sub: string): Promise<void> {
  const { session } = useIde.getState();
  let pasta: Pasta;
  try {
    pasta = { entradas: await listarPasta(sub), erro: "" };
  } catch (causa) {
    pasta = { entradas: [], erro: causa instanceof Error ? causa.message : String(causa) };
  }
  // Descarta se a sessão mudou enquanto a listagem estava em voo.
  useIde.setState((state) =>
    state.session === session ? { tree: { ...state.tree, [sub]: pasta } } : {}
  );
}

/** Primeira carga da árvore — rail e superfície chamam; só a primeira ganha. */
export function bootstrapArvore(): void {
  if (useIde.getState().tree[""] || raizEmVoo) return;
  raizEmVoo = true;
  void carregarPasta("").finally(() => {
    raizEmVoo = false;
  });
}

export function recarregarArvore(): void {
  indice = null;
  useIde.setState({ tree: {}, expanded: new Set<string>() });
  bootstrapArvore();
}

/**
 * Recarrega a árvore EM LUGAR, preservando o que a pessoa deixou aberto.
 *
 * É a reação a uma gravação do BOT (tool.result de fs.write/fs.patch): o
 * arquivo recém-criado tem de aparecer sem clique. O recarregarArvore não
 * serve aqui porque ele zera `expanded` — recolher as pastas que a pessoa
 * abriu esconderia justamente o arquivo novo dentro delas.
 *
 * A raiz e as pastas ABERTAS relistam agora (o conteúdo antigo fica na tela
 * enquanto a resposta não chega — sem piscada); as fechadas SAEM do cache,
 * porque a gravação as deixou velhas — a expansão preguiçosa as relista na
 * próxima abertura. Raiz em erro também relista: a gravação que disparou esta
 * atualização é a prova de que o workspace agora existe.
 */
export function atualizarArvore(): void {
  // O índice do Quick Open ficou velho junto com a árvore.
  indice = null;
  const { tree, expanded } = useIde.getState();
  if (!tree[""]) {
    bootstrapArvore();
    return;
  }
  const vivas = ["", ...expanded];
  useIde.setState((state) => {
    const proximo: Record<string, Pasta> = {};
    for (const sub of vivas) {
      const pasta = state.tree[sub];
      if (pasta) proximo[sub] = pasta;
    }
    return { tree: proximo };
  });
  for (const sub of vivas) void carregarPasta(sub);
}

/**
 * Quanto tempo a árvore espera antes de relistar depois de uma gravação.
 * Curto de propósito: é só o bastante para uma RAJADA de fs.write (o bot
 * criando o projeto inteiro) virar UMA relistagem em vez de uma por arquivo.
 */
export const ATRASO_DA_ATUALIZACAO_MS = 150;

/**
 * Agenda a atualização em lugar com debounce. O timer mora AQUI (módulo), não
 * no efeito de quem chama: o cleanup de um efeito cancelaria a atualização
 * pendente num re-render qualquer, e a relistagem prometida nunca aconteceria.
 * Sem relógio de polling — o timer só nasce como reação a um envelope.
 */
export function agendarAtualizacaoDaArvore(): void {
  cancelarAtualizacaoAgendada();
  atualizacaoAgendada = window.setTimeout(() => {
    atualizacaoAgendada = 0;
    atualizarArvore();
  }, ATRASO_DA_ATUALIZACAO_MS);
}

export function alternarPasta(path: string): void {
  useIde.setState((state) => {
    const proximo = new Set(state.expanded);
    if (proximo.has(path)) proximo.delete(path);
    else proximo.add(path);
    return { expanded: proximo };
  });
  if (!useIde.getState().tree[path]) void carregarPasta(path);
}

function patchArquivo(path: string, muda: (arquivo: ArquivoAberto) => Partial<ArquivoAberto>): void {
  useIde.setState((state) => ({
    files: state.files.map((arquivo) =>
      arquivo.path === path ? { ...arquivo, ...muda(arquivo) } : arquivo
    )
  }));
}

/** Só troca a aba visível — o chip de salvo é do gesto anterior, morre junto. */
export function ativarArquivo(path: string): void {
  useIde.setState({ activePath: path, saveState: "parado", saveErro: "" });
}

/**
 * A marca que o fs.read deixa quando o arquivo passou do teto de 512 KiB do
 * gateway. Buffer cortado NÃO pode ser salvo de volta (apagaria o resto do
 * arquivo), então a aba abre em modo somente leitura com o motivo à vista.
 */
const MARCA_DE_CORTE = "… (arquivo cortado:";

/**
 * Lê `path` do disco (fs.read) e assenta o conteúdo na aba. É o miolo comum de
 * abrir e de RECARREGAR: a resposta de sessão trocada é descartada, e uma aba
 * que ficou SUJA durante o await não é tocada — a pessoa pode ter começado a
 * digitar enquanto a leitura viajava, e o rascunho local vence sempre.
 */
async function lerDoDisco(path: string, session: string): Promise<void> {
  const resultado = await chamarFerramenta("fs.read", { path });
  if (useIde.getState().session !== session) return;
  if (!resultado.ok) {
    patchArquivo(path, () => ({ loading: false, erro: resultado.error }));
    return;
  }
  const cortado = resultado.output.includes(MARCA_DE_CORTE);
  patchArquivo(path, (atual) =>
    atual.dirty
      ? {}
      : {
          content: resultado.output,
          savedContent: resultado.output,
          loading: false,
          erro: cortado
            ? "arquivo maior que o teto de leitura do gateway — aberto somente para leitura (salvar gravaria um arquivo cortado)"
            : ""
        }
  );
}

export async function abrirArquivo(entrada: Pick<EntradaProjeto, "name" | "path">): Promise<void> {
  const { files, session } = useIde.getState();
  ativarArquivo(entrada.path);
  if (files.some((arquivo) => arquivo.path === entrada.path)) return;
  useIde.setState((state) => ({
    files: [
      ...state.files,
      {
        path: entrada.path,
        name: entrada.name,
        content: "",
        savedContent: "",
        dirty: false,
        loading: true,
        erro: ""
      }
    ]
  }));
  await lerDoDisco(entrada.path, session);
}

/**
 * O bot GRAVOU `path` (tool.result confirmado de fs.write/fs.patch) e a IDE
 * está aberta na sessão: o arquivo entra no palco — é o que mata o "nenhum
 * arquivo aberto" no primeiro arquivo do bot. Três casos, três destinos:
 *
 * - aba SUJA: nada de recarregar (o rascunho da pessoa vence, mesma regra do
 *   abrirVindoDaConversa) — fica só o aviso `avisoDoBot`, para ela saber que o
 *   disco mudou por baixo antes de salvar por cima;
 * - aba limpa já aberta: ativa e RELÊ do disco — o buffer antigo é a versão de
 *   antes da gravação, e mostrá-lo como atual seria mentira;
 * - sem aba: abre pelo caminho normal (fs.read pela rota /v1/tools/call).
 */
export async function abrirGravadoPeloBot(path: string): Promise<void> {
  const { files, session } = useIde.getState();
  const aberto = files.find((arquivo) => arquivo.path === path);
  if (aberto?.dirty) {
    useIde.setState({ avisoDoBot: path });
    return;
  }
  if (!aberto) {
    await abrirArquivo({ name: nomeBase(path), path });
    return;
  }
  ativarArquivo(path);
  // Carga em voo: a leitura que já corre vai assentar o conteúdo — pedir outra
  // agora seria um POST a mais para o mesmo dado.
  if (aberto.loading) return;
  await lerDoDisco(path, session);
}

/** O timer que consome o alvo — o miolo comum do agendamento e da entrega. */
function dispararAberturaAgendada(): void {
  aberturaAgendada = window.setTimeout(() => {
    aberturaAgendada = 0;
    const alvo = aberturaAlvo;
    aberturaAlvo = "";
    void abrirGravadoPeloBot(alvo);
  }, ATRASO_DA_ATUALIZACAO_MS);
}

/**
 * Agenda a abertura ao vivo com o MESMO debounce da árvore: uma rajada de
 * gravações (o bot criando o projeto inteiro) abre só o ÚLTIMO arquivo, em vez
 * de um fs.read por gravação e uma dança de abas. O timer mora no módulo pelo
 * mesmo motivo do agendarAtualizacaoDaArvore — o cleanup de um efeito o
 * cancelaria num re-render qualquer.
 *
 * Com `turnoVivo`, o alvo fica RETIDO até o fechamento do turno: o modelo
 * trabalha numa CÓPIA do projeto (o staging do gateway) e o arquivo só chega
 * ao projeto visível quando a promoção roda, antes do done. Abrir no instante
 * do tool.result seria um fs.read de um arquivo que ainda não foi entregue —
 * 404 até o turno fechar. Quem destrava é `entregarAberturaDoBot` (done) ou
 * `descartarAberturaDoBot` (falha/descarte). Sem turno vivo vale o caminho
 * antigo: não há entrega pendente para esperar.
 */
export function agendarAberturaDoBot(path: string, turnoVivo = false): void {
  if (path === "") return;
  aberturaAlvo = path;
  if (aberturaAgendada !== 0) {
    window.clearTimeout(aberturaAgendada);
    aberturaAgendada = 0;
  }
  if (turnoVivo) return;
  dispararAberturaAgendada();
}

/**
 * O turno FECHOU bem (done): a promoção do staging acabou de entregar os
 * arquivos ao projeto — agora sim o alvo retido pode abrir de verdade.
 * Reaproveita o mesmo debounce da abertura normal só para o fs.read assentar
 * pelo caminho único; sem alvo retido é neutro.
 */
export function entregarAberturaDoBot(): void {
  if (aberturaAlvo === "") return;
  if (aberturaAgendada !== 0) window.clearTimeout(aberturaAgendada);
  dispararAberturaAgendada();
}

/**
 * O turno morreu sem entregar (falha, interrupção, recusa do portão): o
 * gateway DESCARTOU o staging e o arquivo retido nunca chegou ao projeto.
 * Abrir agora seria criar uma aba fantasma com erro de leitura — o alvo morre
 * junto com o staging.
 */
export function descartarAberturaDoBot(): void {
  cancelarAberturaAgendada();
}

/**
 * A ponte da CONVERSA para as abas: arquivo que uma ferramenta do especialista
 * leu vira aba aqui, com o conteúdo que a ferramenta devolveu. É o que a tela
 * antiga fazia — e continua valendo porque o especialista trabalha em paralelo
 * com a pessoa. O rascunho local VENCE: se a aba está suja, o conteúdo novo é
 * ignorado em vez de apagar o que a pessoa digitou e não salvou.
 */
export function abrirVindoDaConversa(path: string, content: string): void {
  useIde.setState((state) => {
    const atual = state.files.find((arquivo) => arquivo.path === path);
    if (!atual) {
      return {
        files: [
          ...state.files,
          { path, name: nomeBase(path), content, savedContent: content, dirty: false, loading: false, erro: "" }
        ],
        // Só assume o palco se ele estava vazio — trocar a aba ativa por baixo
        // de quem está editando outra seria roubo de foco.
        activePath: state.activePath === "" ? path : state.activePath
      };
    }
    if (atual.dirty || atual.loading || atual.content === content) return {};
    return {
      files: state.files.map((arquivo) =>
        arquivo.path === path ? { ...arquivo, content, savedContent: content, erro: "" } : arquivo
      )
    };
  });
}

export function editarAtivo(texto: string): void {
  useIde.setState((state) => ({
    saveState: "parado",
    saveErro: "",
    files: state.files.map((arquivo) =>
      arquivo.path === state.activePath && arquivo.erro === "" && !arquivo.loading
        ? { ...arquivo, content: texto, dirty: texto !== arquivo.savedContent }
        : arquivo
    )
  }));
}

export function fecharArquivo(path: string): void {
  useIde.setState((state) => {
    const files = state.files.filter((arquivo) => arquivo.path !== path);
    return {
      files,
      activePath: state.activePath === path ? files[files.length - 1]?.path ?? "" : state.activePath,
      // O aviso era sobre o rascunho desta aba; fechada ela, não há mais o que
      // proteger — a próxima abertura lê o disco (a versão do bot).
      avisoDoBot: state.avisoDoBot === path ? "" : state.avisoDoBot
    };
  });
}

/** Some com o chip "salvo" depois do brilho de confirmação. */
function agendarLimpezaDoSalvo(): void {
  window.setTimeout(
    () => useIde.setState((state) => (state.saveState === "salvo" ? { saveState: "parado" } : {})),
    2200
  );
}

export async function salvarAtivo(): Promise<void> {
  const state = useIde.getState();
  const arquivo = state.files.find((item) => item.path === state.activePath);
  if (!arquivo || arquivo.loading || arquivo.erro !== "" || state.saveState === "salvando") return;
  const { session } = state;
  const conteudo = arquivo.content;
  useIde.setState({ saveState: "salvando", saveErro: "" });
  const resultado = await chamarFerramenta("fs.write", { path: arquivo.path, content: conteudo });
  if (useIde.getState().session !== session) return;
  if (!resultado.ok) {
    useIde.setState({ saveState: "erro", saveErro: resultado.error });
    return;
  }
  patchArquivo(arquivo.path, (atual) => ({
    // Editar DURANTE o await é possível (a gravação espera o cartão de
    // aprovação). Marcar limpo sem conferir apagaria o indicador de sujo com o
    // texto já diferente do que foi gravado — e a pessoa fecharia a aba
    // confiando no chip "salvo".
    dirty: atual.content !== conteudo,
    savedContent: conteudo
  }));
  useIde.setState((state) => ({
    saveState: "salvo",
    // A gravação da pessoa acabou de vencer a do bot no disco: o aviso de
    // "gravou por cima" deste arquivo já contou o que tinha para contar.
    avisoDoBot: state.avisoDoBot === arquivo.path ? "" : state.avisoDoBot
  }));
  agendarLimpezaDoSalvo();
}

/** O índice em cache, se houver — a paleta abre com ele enquanto revalida. */
export function indiceEmCache(): EntradaProjeto[] | null {
  return indice;
}

/**
 * O índice do Quick Open, coletado por fs.list recursivo com teto e guardado
 * POR SESSÃO. A promessa em voo é compartilhada: abrir a paleta duas vezes
 * seguidas não pode disparar duas varreduras inteiras do projeto.
 */
export function indiceDeArquivos(): Promise<EntradaProjeto[]> {
  if (indice) return Promise.resolve(indice);
  if (indiceEmVoo) return indiceEmVoo;
  const { session } = useIde.getState();
  indiceEmVoo = coletarArquivos(listarPasta, TETO_INDICE)
    .then((arquivos) => {
      if (useIde.getState().session === session) indice = arquivos;
      return arquivos;
    })
    .finally(() => {
      indiceEmVoo = null;
    });
  return indiceEmVoo;
}

/** Ctrl+Shift+F: a busca roda no gateway (fs.search) e volta estruturada. */
export async function buscarNoProjeto(query: string): Promise<OcorrenciaBusca[]> {
  const resultado = await chamarFerramenta("fs.search", { query });
  if (!resultado.ok) throw new Error(resultado.error);
  return parseBusca(resultado.output);
}
