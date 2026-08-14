/**
 * O armazenamento que o `persist` do zustand usa — com freio e com plano B.
 *
 * ## Por que não o `localStorage` direto
 *
 * O `persist` assina o store e grava a CADA `setState`, sem comparar nada.
 * Não importa se a mudança sequer é persistida: `setInput` (uma tecla no
 * composer), `setError`, o avanço de estágio de um turno — todos disparavam
 * `JSON.stringify` do histórico inteiro das dez abas e uma escrita síncrona no
 * disco. Com histórico grande isso é dezenas de milissegundos por tecla, na
 * thread que desenha.
 *
 * Aqui a escrita é COALESCIDA: o valor mais recente fica pendente e vai ao
 * disco uma vez por janela. E é COMPARADA: valor idêntico ao último gravado
 * não vai. As duas juntas transformam "uma escrita por tecla" em "uma escrita
 * por mudança real, no máximo uma por janela".
 *
 * Escrita adiada obriga a fechar a porta: `pagehide` e `visibilitychange`
 * descarregam na hora. Sem isso, fechar o app logo depois de digitar perderia
 * o último segundo — trocar um travamento por perda de dado não seria acordo
 * nenhum.
 *
 * ## O plano B: cota
 *
 * O `localStorage` do webview tem cerca de 5 MB. O teto de conversas permite
 * um blob bem maior, e o `QuotaExceededError` sobe de dentro do `setState` —
 * ou seja, a exceção derrubava a AÇÃO do usuário (enviar a mensagem), não
 * apenas a gravação. Aqui a falha de cota é tratada onde ela nasce: descarta
 * as conversas mais ANTIGAS, tenta de novo, e avisa. Perder o histórico velho
 * é ruim; perder a mensagem que a pessoa acabou de escrever é pior.
 */

/** Subconjunto do `Storage` que este módulo usa — facilita testar. */
export interface ArmazenamentoBruto {
  getItem: (chave: string) => string | null;
  setItem: (chave: string, valor: string) => void;
  removeItem: (chave: string) => void;
}

export interface OpcoesArmazenamento {
  /** Janela de coalescência, em ms. */
  intervalo?: number;
  /** Agenda o flush. Injetável para o teste não depender do relógio. */
  agendar?: (acao: () => void, ms: number) => unknown;
  cancelar?: (handle: unknown) => void;
  /** Chamado quando nem depois de podar coube — a UI mostra o aviso. */
  aoFalhar?: (mensagem: string) => void;
  /** Chamado quando conversas foram descartadas para caber. */
  aoPodar?: (removidas: number) => void;
}

/** Padrão: uma gravação por segundo no máximo. */
const INTERVALO_PADRAO = 1000;

/** Quantas conversas descartar por tentativa quando a cota estoura. */
const PASSO_PODA = 20;

/** Tentativas de poda antes de desistir (20, 40, 80… conversas fora). */
const MAX_TENTATIVAS = 5;

function ehErroDeCota(erro: unknown): boolean {
  if (!(erro instanceof Error)) return false;
  // Firefox usa outro nome, e navegadores antigos usam só o código.
  return (
    erro.name === "QuotaExceededError" ||
    erro.name === "NS_ERROR_DOM_QUOTA_REACHED" ||
    (erro as { code?: number }).code === 22
  );
}

/** Conversa persistida — só o que a poda precisa enxergar. */
interface ConversaPodavel {
  updatedAt?: number;
}

/**
 * Remove as `quantas` conversas mais antigas do payload, olhando todas as abas.
 *
 * Devolve `null` quando não há o que podar (payload sem conversas, ou já
 * vazio) — aí não adianta tentar de novo.
 */
export function podarMaisAntigas(json: string, quantas: number): string | null {
  let dados: { conversations?: Record<string, ConversaPodavel[]> };
  try {
    dados = JSON.parse(json);
  } catch {
    return null;
  }
  // O payload do zustand é `{ state, version }`; o direto é o próprio estado.
  const estado = (dados as { state?: typeof dados }).state ?? dados;
  const porAba = estado.conversations;
  if (!porAba) return null;

  // Junta todas as abas numa lista só para escolher as mais antigas do
  // CONJUNTO: podar por aba deixaria uma aba pouco usada intacta enquanto a
  // conversa de ontem, da aba principal, sumia.
  const todas: Array<{ aba: string; indice: number; quando: number }> = [];
  for (const [aba, lista] of Object.entries(porAba)) {
    if (!Array.isArray(lista)) continue;
    lista.forEach((conversa, indice) => {
      todas.push({ aba, indice, quando: conversa?.updatedAt ?? 0 });
    });
  }
  if (!todas.length) return null;

  todas.sort((a, b) => a.quando - b.quando);
  const condenadas = new Set(todas.slice(0, quantas).map((item) => `${item.aba}:${item.indice}`));
  if (!condenadas.size) return null;

  for (const [aba, lista] of Object.entries(porAba)) {
    if (!Array.isArray(lista)) continue;
    porAba[aba] = lista.filter((_, indice) => !condenadas.has(`${aba}:${indice}`));
  }
  return JSON.stringify(dados);
}

export interface ArmazenamentoPersistido extends ArmazenamentoBruto {
  /** Grava agora o que estiver pendente. Usado ao fechar e no teste. */
  descarregar: () => void;
}

export function criarArmazenamentoPersistido(
  bruto: ArmazenamentoBruto,
  opcoes: OpcoesArmazenamento = {}
): ArmazenamentoPersistido {
  const intervalo = opcoes.intervalo ?? INTERVALO_PADRAO;
  const agendar = opcoes.agendar ?? ((acao, ms) => setTimeout(acao, ms));
  const cancelar = opcoes.cancelar ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  /** Valor esperando a janela fechar, por chave. */
  const pendentes = new Map<string, string>();
  /** Último valor que REALMENTE entrou no disco, por chave. */
  const gravados = new Map<string, string>();
  let handle: unknown = null;

  function gravarComPoda(chave: string, valor: string) {
    try {
      bruto.setItem(chave, valor);
      gravados.set(chave, valor);
      return;
    } catch (erro) {
      if (!ehErroDeCota(erro)) throw erro;
    }

    let candidato = valor;
    let removidas = 0;
    for (let tentativa = 0; tentativa < MAX_TENTATIVAS; tentativa += 1) {
      removidas += PASSO_PODA * (tentativa + 1);
      const podado = podarMaisAntigas(candidato, PASSO_PODA * (tentativa + 1));
      if (!podado) break;
      candidato = podado;
      try {
        bruto.setItem(chave, candidato);
        gravados.set(chave, candidato);
        opcoes.aoPodar?.(removidas);
        return;
      } catch (erro) {
        if (!ehErroDeCota(erro)) throw erro;
      }
    }

    /*
     * Nem podando coube. Não relança: a exceção viria de dentro do `setState`
     * e mataria a ação do usuário (o envio da mensagem), quando o problema é
     * só a gravação. O estado em memória segue correto; o que se perde é a
     * durabilidade, e disso a pessoa precisa saber.
     */
    opcoes.aoFalhar?.(
      "O histórico não coube no armazenamento local. O trabalho desta sessão continua na tela, " +
        "mas pode não sobreviver ao fechamento — exporte as conversas importantes."
    );
  }

  function descarregar() {
    if (handle !== null) {
      cancelar(handle);
      handle = null;
    }
    if (!pendentes.size) return;
    const lote = [...pendentes.entries()];
    pendentes.clear();
    for (const [chave, valor] of lote) gravarComPoda(chave, valor);
  }

  return {
    getItem: (chave) => {
      // Pendente ainda não gravado é o valor mais atual — devolver o do disco
      // aqui entregaria uma versão velha.
      const pendente = pendentes.get(chave);
      return pendente !== undefined ? pendente : bruto.getItem(chave);
    },
    setItem: (chave, valor) => {
      // Idêntico ao que já está no disco: a escrita não teria efeito nenhum.
      // É o caso comum — `setInput`, `setError` e o avanço de estágio não
      // mexem em nada que seja persistido.
      if (gravados.get(chave) === valor) {
        pendentes.delete(chave);
        return;
      }
      pendentes.set(chave, valor);
      if (handle === null) {
        handle = agendar(() => {
          handle = null;
          descarregar();
        }, intervalo);
      }
    },
    removeItem: (chave) => {
      pendentes.delete(chave);
      gravados.delete(chave);
      bruto.removeItem(chave);
    },
    descarregar
  };
}
