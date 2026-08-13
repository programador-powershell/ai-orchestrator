/**
 * Operações estruturadas "chat → superfície".
 * O modelo devolve blocos ```ops:<canal> [ ... ]``` e a view do canal aplica.
 * Ex.: Data usa ops:data para criar/alterar tabelas do diagrama pelo chat.
 */

export interface StructuredOp {
  op: string;
  [key: string]: unknown;
}

/** Extrai as operações de um canal do texto do modelo. Puro, testável. */
export function parseOps(text: string, channel: string): StructuredOp[] {
  const pattern = new RegExp("```ops:" + channel + "\\s*([\\s\\S]*?)```", "g");
  const ops: StructuredOp[] = [];
  for (const match of text.matchAll(pattern)) {
    try {
      const parsed = JSON.parse(match[1]) as unknown;
      if (Array.isArray(parsed)) {
        for (const entry of parsed) {
          if (entry && typeof entry === "object" && typeof (entry as StructuredOp).op === "string") {
            ops.push(entry as StructuredOp);
          }
        }
      }
    } catch {
      // Bloco malformado é ignorado; o texto do modelo continua visível no chat.
    }
  }
  return ops;
}

/** Instrução de sistema que ensina o modelo a emitir ops de um canal. */
export function opsInstruction(channel: string, catalog: Record<string, string>): string {
  const list = Object.entries(catalog)
    .map(([op, description]) => `- {"op": "${op}", …}: ${description}`)
    .join("\n");
  return (
    `Quando a resposta implicar mudanças na superfície "${channel}", inclua ao final um bloco ` +
    "```ops:" + channel + "``` com um array JSON de operações. Operações disponíveis:\n" + list
  );
}

/* ------------------------------------------------------------------ */
/* Barramento do composer: views disparam envios programáticos reais.  */
/* ------------------------------------------------------------------ */

export interface ComposerSendOptions {
  /** false = não ecoa a mensagem do usuário no thread (ex.: regenerar). */
  echoUser?: boolean;
}

type ComposerListener = (text: string, options?: ComposerSendOptions) => void;
let composerListener: ComposerListener | null = null;

export const composerBus = {
  register(listener: ComposerListener): () => void {
    composerListener = listener;
    return () => {
      if (composerListener === listener) composerListener = null;
    };
  },
  send(text: string, options?: ComposerSendOptions) {
    composerListener?.(text, options);
  }
};

/* ------------------------------------------------------------------ */
/* Caminho inverso: o composer entrega o texto para a VIEW tratar.     */
/* ------------------------------------------------------------------ */

type GoalListener = (text: string) => void;
const goalListeners = new Map<string, GoalListener>();

/**
 * Barramento de OBJETIVO — o composer é a entrada, a aba executa.
 *
 * Existe para a aba Agent não precisar de campo próprio: a pessoa escreve o
 * que quer na mesma caixa de sempre e a equipe é acionada dali. Um segundo
 * campo no corpo faria a mesma coisa de dois jeitos, e ninguém saberia qual
 * dos dois manda.
 *
 * Um ouvinte por modo: dois seriam duas execuções para um envio.
 */
export const goalBus = {
  register(mode: string, listener: GoalListener): () => void {
    goalListeners.set(mode, listener);
    return () => {
      if (goalListeners.get(mode) === listener) goalListeners.delete(mode);
    };
  },
  /** true quando alguém assumiu o envio — o composer não segue com o chat. */
  deliver(mode: string, text: string): boolean {
    const listener = goalListeners.get(mode);
    if (!listener) return false;
    listener(text);
    return true;
  }
};

type OpsListener = (ops: StructuredOp[]) => void;
const listeners = new Map<string, Set<OpsListener>>();

/** Barramento simples: o Composer publica, a view do canal aplica. */
export const opsBus = {
  subscribe(channel: string, listener: OpsListener): () => void {
    const set = listeners.get(channel) ?? new Set();
    set.add(listener);
    listeners.set(channel, set);
    return () => set.delete(listener);
  },
  publish(channel: string, text: string) {
    const ops = parseOps(text, channel);
    if (!ops.length) return;
    for (const listener of listeners.get(channel) ?? []) listener(ops);
  }
};
