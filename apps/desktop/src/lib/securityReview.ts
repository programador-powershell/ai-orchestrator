/**
 * Revisão profunda de segurança — candidatos, investigação e REFUTAÇÃO.
 *
 * A revisão anterior (`buildReviewPrompt`, em scan.ts) tem dois problemas que
 * este módulo existe para resolver:
 *
 * 1. **Mandava N arquivos num prompt só**, cada um cortado em 6.000
 *    caracteres. O corte cai no meio de uma função e a atenção do modelo se
 *    divide entre os arquivos. Aqui cada candidato é investigado sozinho.
 * 2. **Não tinha segunda opinião.** O que o modelo dissesse virava achado na
 *    tela. Falso positivo é o que faz um painel de segurança ser ignorado —
 *    inclusive quando ele acerta.
 *
 * O fluxo, em três passos:
 *
 * - **Candidatos**: varredura por expressão regular, SEM modelo, aponta os
 *   arquivos que tocam autenticação, entrada de usuário, execução, SQL, disco
 *   ou criptografia. É barata e reduz o que vai custar token.
 * - **Investigação**: um agente por candidato, com o arquivo inteiro (ou
 *   cortado em limite de linha, e avisando).
 * - **Refutação**: um segundo agente tenta **derrubar** cada achado. A pergunta
 *   é "prove que isto NÃO é explorável", e a dúvida conta a favor de refutar —
 *   é assim que a taxa de falso positivo cai de verdade.
 *
 * O que foi refutado **não é apagado**: fica marcado com o motivo. Apagar em
 * silêncio esconderia uma refutação agressiva demais, e ninguém perceberia que
 * a revisão parou de achar coisa real.
 *
 * Módulo puro: sem rede, sem DOM. Coberto por securityReview.test.ts.
 */

import type { SecurityFinding } from "@ai-orchestrator/contracts";

import type { ChatMessage } from "./gateway";
import { runWithLimit } from "./pool";

type Severity = SecurityFinding["severity"];

/* ----------------------------- Candidatos ----------------------------- */

export interface Matcher {
  id: string;
  /** O que este padrão indica — vai no prompt da investigação. */
  label: string;
  pattern: RegExp;
  /** Peso na priorização. Sinal mais perigoso, peso maior. */
  weight: number;
}

/**
 * Matchers padrão.
 *
 * Eles não afirmam vulnerabilidade: afirmam **superfície**. Um `req.query` não
 * é bug, mas é onde bug de injeção mora — e é isso que decide quais arquivos
 * merecem uma investigação paga.
 */
export const DEFAULT_MATCHERS: Matcher[] = [
  {
    id: "exec",
    label: "executa processo ou avalia código",
    pattern: /\b(?:child_process|execSync|exec\(|spawn\(|eval\(|new Function\(|vm\.run)/,
    weight: 5
  },
  {
    id: "sql",
    label: "monta SQL",
    pattern: /\b(?:SELECT\s+.+\s+FROM|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|\.query\(|\.raw\()/i,
    weight: 4
  },
  {
    id: "auth",
    label: "decide autenticação ou autorização",
    pattern: /\b(?:isAdmin|hasRole|hasPermission|authorize|authenticate|checkAuth|requireAuth|verifyToken|jwt\.|session\.|currentUser)/,
    weight: 5
  },
  {
    id: "input",
    label: "lê entrada do usuário",
    pattern: /\b(?:req\.(?:query|body|params|headers|cookies)|searchParams|formData\(|request\.json\(\))/,
    weight: 3
  },
  {
    id: "html",
    label: "escreve HTML dinâmico",
    pattern: /\b(?:innerHTML|outerHTML|dangerouslySetInnerHTML|document\.write|insertAdjacentHTML)/,
    weight: 4
  },
  {
    id: "fs",
    label: "toca o sistema de arquivos por caminho",
    pattern: /\b(?:readFile|writeFile|createReadStream|createWriteStream|unlink|path\.join|fs\.)/,
    weight: 3
  },
  {
    id: "crypto",
    label: "usa criptografia ou aleatoriedade",
    pattern: /\b(?:md5|sha1|createCipher\b|Math\.random\(\)|crypto\.randomBytes|bcrypt|scrypt|pbkdf2)/i,
    weight: 3
  },
  {
    id: "net",
    label: "faz requisição a outro serviço",
    pattern: /\b(?:fetch\(|axios\.|http\.request|https\.request|XMLHttpRequest)/,
    weight: 2
  },
  {
    id: "redirect",
    label: "redireciona com valor de fora",
    pattern: /\b(?:res\.redirect|window\.location\s*=|location\.href\s*=|redirect\()/,
    weight: 3
  },
  {
    id: "deserialize",
    label: "desserializa dado externo",
    pattern: /\b(?:JSON\.parse\(|yaml\.load\(|deserialize|pickle\.loads|unserialize)/,
    weight: 2
  }
];

export interface Candidate {
  path: string;
  /** Rótulos dos matchers que bateram — entram no prompt. */
  reasons: string[];
  score: number;
}

export interface CandidateOptions {
  matchers?: Matcher[];
  /** Teto de candidatos. O resto fica de fora e o chamador é avisado. */
  limit?: number;
}

/**
 * Arquivos que não vale investigar: gerados, minificados, binários.
 *
 * O `(?:^|\/)` antes das pastas é o que faz `node_modules/x.js` ser pego: o
 * caminho vem relativo à raiz do projeto e **não** começa com barra.
 */
const IGNORAR = /(?:\.min\.|\.map$|(?:^|\/)(?:node_modules|dist|build|out|target|coverage|\.next)\/|\.(?:lock|svg|png|jpe?g|gif|ico|woff2?)$)/i;

/**
 * Escolhe os arquivos que merecem investigação.
 *
 * Ordena por peso somado: quem toca autenticação E executa processo vem antes
 * de quem só faz `fetch`. Quando o teto corta, corta a cauda menos perigosa.
 */
export function findCandidates(
  files: Array<{ path: string; content: string }>,
  options: CandidateOptions = {}
): { candidates: Candidate[]; skipped: number } {
  const matchers = options.matchers ?? DEFAULT_MATCHERS;
  const encontrados: Candidate[] = [];
  for (const file of files) {
    if (IGNORAR.test(file.path)) continue;
    const reasons: string[] = [];
    let score = 0;
    for (const matcher of matchers) {
      // `lastIndex` de regex global vaza entre arquivos e faria o segundo
      // arquivo pular o começo — por isso os padrões não são globais.
      if (matcher.pattern.test(file.content)) {
        reasons.push(matcher.label);
        score += matcher.weight;
      }
    }
    if (reasons.length) encontrados.push({ path: file.path, reasons, score });
  }
  encontrados.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  const limite = options.limit ?? 40;
  return {
    candidates: encontrados.slice(0, limite),
    skipped: Math.max(0, encontrados.length - limite)
  };
}

/* ---------------------------- Retomada ---------------------------- */

/**
 * Impressão do conteúdo (FNV-1a de 32 bits).
 *
 * Serve para saber se o arquivo mudou desde a última varredura. Arquivo
 * intacto não precisa ser investigado de novo — e investigação é o passo caro.
 */
export function fingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

/** Caminho → impressão do conteúdo já investigado. */
export type ReviewProgress = Record<string, string>;

export interface ResumePlan {
  /** Candidatos que precisam de investigação nesta volta. */
  pending: Candidate[];
  /** Reaproveitados: mesmo arquivo, mesmo conteúdo. */
  reused: string[];
}

/**
 * Decide o que reinvestigar.
 *
 * Varredura de repositório real leva bastante tempo, e hoje uma interrupção
 * jogava tudo fora. Aqui só volta ao modelo o que **mudou** — e o que foi
 * reaproveitado é declarado, senão a segunda volta pareceria ter revisado o
 * projeto inteiro de novo.
 */
export function planResume(
  candidates: Candidate[],
  files: Array<{ path: string; content: string }>,
  progress: ReviewProgress
): ResumePlan {
  const porCaminho = new Map(files.map((file) => [file.path, file.content]));
  const pending: Candidate[] = [];
  const reused: string[] = [];
  for (const candidate of candidates) {
    const conteudo = porCaminho.get(candidate.path);
    const anterior = progress[candidate.path];
    if (conteudo !== undefined && anterior && anterior === fingerprint(conteudo)) {
      reused.push(candidate.path);
      continue;
    }
    pending.push(candidate);
  }
  return { pending, reused };
}

/* --------------------------- Investigação --------------------------- */

/** Corta no limite de LINHA e avisa — cortar no meio de uma função esconde o bug. */
export function clipAtLine(content: string, maxChars: number): { text: string; clipped: boolean } {
  if (content.length <= maxChars) return { text: content, clipped: false };
  const bruto = content.slice(0, maxChars);
  const corte = bruto.lastIndexOf("\n");
  return { text: corte > maxChars / 2 ? bruto.slice(0, corte) : bruto, clipped: true };
}

const MAX_FILE_CHARS = 24_000;

export function buildInvestigationPrompt(
  file: { path: string; content: string },
  reasons: string[]
): ChatMessage[] {
  const { text, clipped } = clipAtLine(file.content, MAX_FILE_CHARS);
  return [
    {
      role: "system",
      content: [
        "Você é um pesquisador de segurança investigando UM arquivo.",
        "Rastreie o fluxo do dado: de onde ele entra, por onde passa, onde é usado.",
        "Verifique se já existe mitigação (validação, escape, parâmetro ligado, checagem de permissão) ANTES de apontar.",
        "Não aponte estilo, desempenho nem preferência — só o que um atacante consegue explorar.",
        "Nunca reproduza o valor de um segredo: mascare.",
        "Responda com um resumo curto e, obrigatoriamente, um bloco ```json com um array " +
          '[{"severity":"critical"|"high"|"medium"|"low"|"info","title":string,"file":string,"line"?:number,"detail":string,"suggestion"?:string}]. ' +
          "Array vazio quando não houver nada explorável — dizer que não achou é uma resposta válida e esperada."
      ].join(" ")
    },
    {
      role: "user",
      content: [
        `Arquivo: ${file.path}`,
        `A pré-varredura marcou este arquivo porque ele: ${reasons.join("; ")}.`,
        clipped ? "ATENÇÃO: o arquivo foi cortado; considere só o trecho abaixo." : "",
        "",
        "```",
        text,
        "```"
      ]
        .filter(Boolean)
        .join("\n")
    }
  ];
}

/* ---------------------------- Refutação ---------------------------- */

export interface Verdict {
  /** true = a refutação FALHOU, ou seja, o achado se sustenta. */
  confirmed: boolean;
  severity?: Severity;
  reason: string;
}

/**
 * Prompt da refutação.
 *
 * A pergunta é adversarial de propósito: pedir "confirme se é verdade" faz o
 * modelo concordar com o que já está escrito. Pedir para **derrubar** obriga
 * a procurar a mitigação — e a dúvida conta a favor de refutar.
 */
export function buildRevalidationPrompt(
  finding: SecurityFinding,
  file: { path: string; content: string }
): ChatMessage[] {
  const { text, clipped } = clipAtLine(file.content, MAX_FILE_CHARS);
  return [
    {
      role: "system",
      content: [
        "Você REFUTA achados de segurança. Sua tarefa é derrubar o achado abaixo, não confirmá-lo.",
        "Procure a mitigação que o investigador pode ter perdido: validação anterior, consulta parametrizada, escape do framework, checagem de permissão em middleware, valor que nunca vem do usuário.",
        "Se você não conseguir demonstrar um caminho de exploração concreto, o achado é REFUTADO.",
        "Na dúvida, refute: um alerta falso faz o painel inteiro ser ignorado.",
        'Responda SOMENTE com ```json {"confirmed":boolean,"severity":"critical"|"high"|"medium"|"low"|"info","reason":"uma frase"}.'
      ].join(" ")
    },
    {
      role: "user",
      content: [
        `ACHADO: [${finding.severity}] ${finding.title}`,
        finding.line ? `Linha indicada: ${finding.line}` : "",
        `Detalhe: ${finding.detail}`,
        "",
        `Arquivo ${file.path}${clipped ? " (cortado)" : ""}:`,
        "```",
        text,
        "```"
      ]
        .filter(Boolean)
        .join("\n")
    }
  ];
}

const SEVERIDADES: ReadonlySet<string> = new Set(["critical", "high", "medium", "low", "info"]);

/**
 * Lê o veredito.
 *
 * Resposta ilegível **confirma** o achado, ao contrário da dúvida do modelo:
 * são coisas diferentes. Quando o refutador diz "não consigo derrubar", isso é
 * sinal; quando ele responde lixo, não é sinal nenhum — e descartar o achado
 * por falha de parsing esconderia um problema real.
 */
export function parseVerdict(raw: string): Verdict {
  const texto = raw.replace(/```(?:json)?/gi, "").trim();
  const inicio = texto.indexOf("{");
  const fim = texto.lastIndexOf("}");
  if (inicio < 0 || fim <= inicio) {
    return { confirmed: true, reason: "o refutador não respondeu num formato utilizável" };
  }
  try {
    const valor = JSON.parse(texto.slice(inicio, fim + 1)) as {
      confirmed?: unknown;
      severity?: unknown;
      reason?: unknown;
    };
    const severity = String(valor.severity ?? "").toLowerCase();
    return {
      confirmed: valor.confirmed !== false,
      severity: SEVERIDADES.has(severity) ? (severity as Severity) : undefined,
      reason: typeof valor.reason === "string" ? valor.reason.trim() : ""
    };
  } catch {
    return { confirmed: true, reason: "o refutador não respondeu num formato utilizável" };
  }
}

/* ------------------------------ Execução ------------------------------ */

export interface ReviewedFinding extends SecurityFinding {
  /** Por que o refutador manteve ou derrubou. */
  verdict: Verdict;
}

export interface DeepReviewHooks {
  /** Progresso: qual arquivo está sendo investigado agora. */
  onStage?: (text: string) => void;
  /** Um achado passou pela refutação (confirmado ou não). */
  onFinding?: (finding: ReviewedFinding) => void;
}

export interface DeepReviewOptions {
  files: Array<{ path: string; content: string }>;
  /** Chamada de modelo. Injetada para o teste não tocar a rede. */
  call: (messages: ChatMessage[], signal: AbortSignal) => Promise<string>;
  /** Extrai os achados do texto — reaproveita o parser da revisão antiga. */
  parse: (text: string) => SecurityFinding[];
  signal: AbortSignal;
  hooks?: DeepReviewHooks;
  matchers?: Matcher[];
  /** Investigações simultâneas. */
  concurrency?: number;
  /** Teto de candidatos investigados. */
  limit?: number;
  /** O que já foi investigado numa volta anterior. */
  progress?: ReviewProgress;
}

export interface DeepReviewResult {
  confirmed: ReviewedFinding[];
  refuted: ReviewedFinding[];
  investigated: number;
  /** Candidatos que ficaram fora do teto — dizer isso evita falsa sensação de cobertura. */
  skipped: number;
  /** Arquivos pulados por não terem mudado desde a volta anterior. */
  reused: number;
  /** Progresso atualizado, para o chamador guardar e retomar depois. */
  progress: ReviewProgress;
  cancelled: boolean;
}

/**
 * Transforma um achado em objetivo para a equipe de agentes.
 *
 * O deepsec exporta os achados como instrução para um agente de código
 * consumir. Aqui o destino é a aba Agent: o texto vira o pedido, e o
 * orquestrador escala a equipe a partir dele.
 */
export function findingToGoal(finding: SecurityFinding): string {
  return [
    `Corrigir a falha de segurança: ${finding.title}`,
    "",
    `Arquivo: ${finding.file}${finding.line ? `:${finding.line}` : ""}`,
    `Severidade: ${finding.severity}`,
    `Detalhe: ${finding.detail}`,
    finding.suggestion ? `Sugestão do revisor: ${finding.suggestion}` : "",
    "",
    "Confirme a falha no código antes de mudar qualquer coisa, e não altere comportamento além do necessário para fechá-la."
  ]
    .filter(Boolean)
    .join("\n");
}

export async function runDeepReview(options: DeepReviewOptions): Promise<DeepReviewResult> {
  const { candidates, skipped } = findCandidates(options.files, {
    matchers: options.matchers,
    limit: options.limit
  });
  const { pending, reused } = planResume(candidates, options.files, options.progress ?? {});
  const porCaminho = new Map(options.files.map((file) => [file.path, file]));
  const confirmed: ReviewedFinding[] = [];
  const refuted: ReviewedFinding[] = [];
  const progress: ReviewProgress = { ...(options.progress ?? {}) };
  let investigated = 0;

  const tarefas = pending.map((candidate) => async () => {
    if (options.signal.aborted) return;
    const file = porCaminho.get(candidate.path);
    if (!file) return;
    options.hooks?.onStage?.(`investigando ${candidate.path}`);
    const bruto = await options.call(buildInvestigationPrompt(file, candidate.reasons), options.signal);
    investigated += 1;
    const achados = options.parse(bruto);

    for (const finding of achados) {
      if (options.signal.aborted) return;
      options.hooks?.onStage?.(`refutando ${finding.title}`);
      const respostaRefutacao = await options.call(
        buildRevalidationPrompt(finding, file),
        options.signal
      );
      const verdict = parseVerdict(respostaRefutacao);
      const revisado: ReviewedFinding = {
        ...finding,
        // A refutação pode REBAIXAR a severidade; ela conhece a mitigação que
        // o investigador não viu.
        severity: verdict.severity ?? finding.severity,
        verdict
      };
      (verdict.confirmed ? confirmed : refuted).push(revisado);
      options.hooks?.onFinding?.(revisado);
    }

    /**
     * Só agora: o arquivo foi investigado E todos os achados foram julgados.
     *
     * Marcar logo após a investigação economizava uma chamada quando a
     * revisão era interrompida no meio das refutações — mas o preço era
     * perder achado. Um erro de rede numa refutação (a exceção morre dentro
     * do runWithLimit) deixava o arquivo carimbado como revisado com os
     * achados restantes nunca exibidos: a volta seguinte respondia "nada
     * mudou desde a última revisão" e a falha sumia até alguém editar o
     * arquivo. Repetir uma investigação custa uma chamada; esconder uma
     * falha de segurança custa a confiança no painel inteiro.
     */
    progress[candidate.path] = fingerprint(file.content);
  });

  await runWithLimit(tarefas, options.concurrency ?? 3);

  const ordem: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  confirmed.sort((a, b) => ordem[a.severity] - ordem[b.severity]);
  return {
    confirmed,
    refuted,
    investigated,
    skipped,
    reused: reused.length,
    progress,
    cancelled: options.signal.aborted
  };
}
