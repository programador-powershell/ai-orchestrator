/**
 * Rail do especialista de Código: a árvore REAL do projeto da sessão.
 *
 * Substitui o placeholder permanente do Rail.tsx ("a árvore aparece aqui…" sem
 * nenhum caminho de código que a enchesse). O dado vem do gateway por
 * fs.list na rota /v1/tools/call — expansão preguiçosa: cada pasta só é
 * listada quando alguém a abre, porque cada nível é um POST.
 *
 * Regra herdada do Rail: vazio HONESTO. Sem gateway não há árvore, e a coluna
 * diz isso com todas as letras — inventar arquivos de exemplo aqui faria a
 * pessoa clicar num arquivo que não existe.
 */
import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import {
  ChevronDown,
  ChevronRight,
  Database,
  File,
  FileCode2,
  FileCog,
  FileImage,
  FileJson,
  FileTerminal,
  FileText,
  Folder,
  FolderOpen,
  Palette,
  RefreshCw,
  WifiOff,
  type LucideIcon
} from "lucide-react";
import { useApp, type AppState } from "../../lib/store";
import {
  abrirArquivo,
  agendarAtualizacaoDaArvore,
  alternarPasta,
  bootstrapArvore,
  recarregarArvore,
  sincronizarSessao,
  useIde
} from "../../lib/ide/ideStore";
import { tipoDoArquivo, type TipoDeArquivo } from "../../lib/ide/projeto";

/**
 * Quantas gravações CONFIRMADAS do bot a conversa carrega (fs.write/fs.patch
 * com ok). É o sinal que mantém a árvore VIVA: os tool.result já chegam ao
 * store como linhas — quando este número sobe, o disco mudou e a árvore
 * relista. Recusa (ok:false) não conta: gravação que não aconteceu não muda
 * pasta nenhuma, e relistar por ela seria um POST em troca de nada.
 */
function contarGravacoesDoBot(state: AppState): number {
  let total = 0;
  for (const line of state.lines) {
    for (const resultado of line.toolResults ?? []) {
      if (resultado.ok && (resultado.tool === "fs.write" || resultado.tool === "fs.patch")) {
        total += 1;
      }
    }
  }
  return total;
}

/** A família (regra pura em lib/ide/projeto) vira ícone AQUI — quem desenha decide. */
const ICONE_POR_TIPO: Record<TipoDeArquivo, LucideIcon> = {
  codigo: FileCode2,
  json: FileJson,
  texto: FileText,
  estilo: Palette,
  imagem: FileImage,
  dados: Database,
  config: FileCog,
  shell: FileTerminal,
  outro: File
};

export function IconeDoArquivo({ name }: { name: string }): ReactNode {
  const Icone = ICONE_POR_TIPO[tipoDoArquivo(name)];
  return <Icone size={13} aria-hidden />;
}

/** Mesma marcação do RailEmpty do Rail.tsx (que não é exportado). */
function Vazio({ icon: Icon, titulo, hint, children }: {
  icon: LucideIcon;
  titulo: string;
  hint: string;
  children?: ReactNode;
}): ReactNode {
  return (
    <div className="rail-empty">
      <Icon size={18} aria-hidden />
      <p className="rail-empty-title">{titulo}</p>
      <p className="rail-empty-hint">{hint}</p>
      {children}
    </div>
  );
}

export function FilesRail(): ReactNode {
  const status = useApp((state) => state.status);
  const session = useApp((state) => state.session);
  const busy = useApp((state) => state.busy);
  const gravacoes = useApp(contarGravacoesDoBot);
  const tree = useIde((state) => state.tree);
  const expanded = useIde((state) => state.expanded);
  const files = useIde((state) => state.files);
  const activePath = useIde((state) => state.activePath);
  const erroDaRaiz = useIde((state) => state.tree[""]?.erro ?? "");

  // A árvore é POR SESSÃO: adotar a sessão nova zera a anterior, e a primeira
  // carga só dispara com o gateway pronto — pedir fs.list offline é gastar um
  // erro para desenhar o que a mensagem de vazio já diz.
  useEffect(() => {
    sincronizarSessao(session ?? "");
    if (status === "ready" && session) bootstrapArvore();
  }, [session, status]);

  // ÁRVORE VIVA: o bot gravou (fs.write/fs.patch com ok) → o disco mudou → a
  // árvore relista sozinha, com debounce curto (rajada de gravações vira UMA
  // relistagem). Só o AUMENTO conta: a primeira observação é o replay/montagem
  // — o bootstrap acabou de listar o estado atual do disco, e as gravações
  // históricas já estão nele. Queda (troca de sessão zera as linhas) só
  // reancora o contador.
  const gravacoesVistas = useRef(-1);
  useEffect(() => {
    const antes = gravacoesVistas.current;
    gravacoesVistas.current = gravacoes;
    if (antes < 0 || gravacoes <= antes) return;
    if (status !== "ready" || !session) return;
    agendarAtualizacaoDaArvore();
  }, [gravacoes, status, session]);

  // RETRY SEM CLIQUE: a árvore que falhou ao montar ("sessão sem pasta de
  // projeto") tenta de novo quando um turno CONCLUI — o gateway provisiona o
  // workspace no primeiro turno de trabalho, então o done é exatamente o
  // momento em que a pasta pode ter passado a existir. O sinal é busy caindo
  // (o mesmo done que o store reduz), nunca um relógio: uma tentativa por
  // conclusão, sem polling.
  const estavaOcupado = useRef(false);
  useEffect(() => {
    const antes = estavaOcupado.current;
    estavaOcupado.current = busy;
    if (!antes || busy) return;
    if (status !== "ready" || !session) return;
    if (erroDaRaiz === "") return;
    recarregarArvore();
  }, [busy, status, session, erroDaRaiz]);

  if (status !== "ready" || !session) {
    return (
      <Vazio
        icon={WifiOff}
        titulo="Sem conexão com o gateway."
        hint="A árvore mostra o projeto REAL da sessão — sem gateway não há o que listar. Ela volta sozinha quando a conexão voltar."
      />
    );
  }

  const raiz = tree[""];

  if (raiz && raiz.erro !== "") {
    return (
      <Vazio icon={FolderOpen} titulo="A árvore não carregou." hint={raiz.erro}>
        <button type="button" className="rail-stencil" onClick={recarregarArvore}>
          <RefreshCw size={12} aria-hidden />
          Tentar de novo
        </button>
      </Vazio>
    );
  }

  function renderEntradas(sub: string, profundidade: number): ReactNode {
    const pasta = tree[sub];
    const recuo = { "--depth": profundidade } as CSSProperties;
    if (!pasta) {
      return (
        <span className="files-tree-note" style={recuo} key={`${sub}#carregando`}>
          carregando…
        </span>
      );
    }
    if (pasta.erro !== "") {
      // A falha aparece NO LUGAR da pasta, com o motivo — nunca some nem vira
      // uma pasta "vazia" de mentira.
      return (
        <span className="files-tree-note files-tree-erro" style={recuo} key={`${sub}#erro`} title={pasta.erro}>
          {pasta.erro}
        </span>
      );
    }
    if (pasta.entradas.length === 0) {
      return (
        <span className="files-tree-note" style={recuo} key={`${sub}#vazio`}>
          vazio
        </span>
      );
    }
    return pasta.entradas.map((entrada) => {
      if (entrada.isDir) {
        const aberta = expanded.has(entrada.path);
        return (
          <div key={entrada.path}>
            <button
              type="button"
              className="files-tree-row"
              style={recuo}
              onClick={() => alternarPasta(entrada.path)}
              title={entrada.path}
            >
              {aberta ? <ChevronDown size={11} aria-hidden /> : <ChevronRight size={11} aria-hidden />}
              {aberta ? <FolderOpen size={13} aria-hidden /> : <Folder size={13} aria-hidden />}
              <span className="files-tree-name">{entrada.name}</span>
            </button>
            {aberta && renderEntradas(entrada.path, profundidade + 1)}
          </div>
        );
      }
      const aba = files.find((arquivo) => arquivo.path === entrada.path);
      return (
        <button
          type="button"
          key={entrada.path}
          className="files-tree-row"
          data-active={activePath === entrada.path}
          style={recuo}
          onClick={() => void abrirArquivo(entrada)}
          title={entrada.path}
        >
          <IconeDoArquivo name={entrada.name} />
          <span className="files-tree-name">{entrada.name}</span>
          {aba?.dirty ? (
            <i className="files-dirty" aria-label="com edições não salvas" />
          ) : (
            <small>{Math.max(1, Math.round(entrada.size / 1024))}k</small>
          )}
        </button>
      );
    });
  }

  return (
    <>
      <div className="files-rail-tools">
        <span className="rail-note">projeto da sessão</span>
        <button
          type="button"
          className="icon-button"
          onClick={recarregarArvore}
          title="Recarregar a árvore"
          aria-label="Recarregar a árvore"
        >
          <RefreshCw size={12} aria-hidden />
        </button>
      </div>
      <div className="files-tree">{renderEntradas("", 0)}</div>
    </>
  );
}

export default FilesRail;
