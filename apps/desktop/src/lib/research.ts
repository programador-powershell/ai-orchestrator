/**
 * Pesquisa profunda — o pipeline roda no cliente, não no provedor.
 *
 * 1. O modelo (via `ask`) propõe até 4 URLs candidatas em JSON.
 * 2. Cada URL é lida via comando Rust `research_fetch`; YouTube usa oEmbed.
 *    Sem desktop/na falha, a fonte é ROTULADA como não verificada (com o
 *    motivo explícito, ex.: "requer o app desktop") e capada em 0.35 de
 *    credibilidade — nunca simulada silenciosamente.
 * 3. O modelo avalia cada fonte (credibilidade 0-1 + resumo de 1 linha) e
 *    sintetiza com citações [n].
 * 4. Monta o ResearchReport com confiança e questões em aberto.
 */
import { invoke } from "@tauri-apps/api/core";
import type { ResearchReport, ResearchSource } from "@orchestrator/contracts";
import { blockedMessage, blockedUrl } from "./blocklist";
import type { ChatMessage } from "./gateway";
import { useApp } from "./store";

const isTauriHost = "__TAURI_INTERNALS__" in window;

export interface ResearchEvents {
  onStage?: (stage: string) => void;
}

interface FetchedPage {
  title: string;
  text: string;
  links: string[];
}

interface GatheredSource {
  source: ResearchSource;
  excerpt: string;
  verified: boolean;
}

interface EvaluationPayload {
  evaluations?: Array<{ index?: number; credibility?: number; summary?: string }>;
  synthesis?: string;
  confidence?: number;
  openQuestions?: string[];
}

const PLANNER_PROMPT =
  "Você é o planejador de uma pesquisa profunda. Dada a pergunta do usuário, devolva APENAS um array JSON " +
  'com até 4 URLs candidatas (strings http/https) que provavelmente respondem à pergunta — sites de referência, ' +
  "documentação oficial e, quando fizer sentido, um vídeo do YouTube. Nenhum texto fora do JSON.";

const EVALUATOR_PROMPT =
  "Você é o avaliador de uma pesquisa profunda. Receberá fontes numeradas com trechos coletados. " +
  "Devolva APENAS um objeto JSON no formato: " +
  '{"evaluations":[{"index":1,"credibility":0.8,"summary":"resumo de 1 linha"}],' +
  '"synthesis":"síntese objetiva citando as fontes como [n]","confidence":0.7,' +
  '"openQuestions":["pergunta ainda sem resposta"]}. ' +
  "credibility e confidence variam de 0 a 1. Fontes sem conteúdo verificado merecem credibilidade baixa. " +
  "Nenhum texto fora do JSON.";

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

function hostLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function detectKind(url: string): ResearchSource["kind"] {
  if (/youtube\.com|youtu\.be/i.test(url)) return "video";
  if (/\.pdf(?:$|[?#])/i.test(url) || /docs\.|readthedocs|developer\./i.test(url)) return "doc";
  return "site";
}

function stripFences(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  return fenced ? fenced[1] : text;
}

function extractJsonArray(text: string): unknown[] | null {
  const raw = stripFences(text);
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as unknown;
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function extractJsonObject(text: string): EvaluationPayload | null {
  const raw = stripFences(text);
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as EvaluationPayload) : null;
  } catch {
    return null;
  }
}

/** URLs de demonstração quando o modelo não devolve candidatas utilizáveis. */
function fallbackCandidates(question: string): string[] {
  const query = encodeURIComponent(question.trim().slice(0, 80));
  return [
    `https://pt.wikipedia.org/w/index.php?search=${query}`,
    `https://developer.mozilla.org/pt-BR/search?q=${query}`,
    `https://www.youtube.com/results?search_query=${query}`
  ];
}

function candidateUrls(question: string, plannerRaw: string): string[] {
  const urls: string[] = [];
  const parsed = extractJsonArray(plannerRaw);
  if (parsed) {
    for (const entry of parsed) {
      if (typeof entry === "string") urls.push(entry);
      else if (entry && typeof entry === "object" && typeof (entry as { url?: unknown }).url === "string") {
        urls.push((entry as { url: string }).url);
      }
    }
  }
  const valid = urls.filter((url) => /^https?:\/\//i.test(url)).slice(0, 4);
  return valid.length ? valid : fallbackCandidates(question);
}

function unverifiedSource(url: string, kind: ResearchSource["kind"], reason: string): GatheredSource {
  return {
    source: {
      url,
      title: hostLabel(url),
      kind,
      credibility: 0.2,
      summary: `fonte não verificada — ${reason}`
    },
    excerpt: "",
    verified: false
  };
}

async function collectYoutube(url: string): Promise<GatheredSource> {
  try {
    const response = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`);
    if (!response.ok) throw new Error(`oEmbed respondeu ${response.status}`);
    const data = (await response.json()) as { title?: string; author_name?: string };
    const title = data.title?.trim() || "Vídeo do YouTube";
    const author = data.author_name?.trim() || "autor desconhecido";
    return {
      source: { url, title, kind: "video", credibility: 0.5, summary: `Vídeo de ${author} — avaliação pendente.` },
      excerpt: `Vídeo do YouTube: "${title}", publicado por ${author}. Apenas metadados disponíveis (sem transcrição).`,
      verified: true
    };
  } catch {
    return unverifiedSource(url, "video", "o oEmbed do YouTube não respondeu");
  }
}

async function collectSource(url: string): Promise<GatheredSource> {
  const kind = detectKind(url);
  /**
   * A blocklist do admin vale para TODA fonte, inclusive o desvio do vídeo.
   *
   * O `collectYoutube` sai por `fetch` do renderer e não passa pelo
   * `research_fetch` do Rust, onde a política assinada é aplicada — com
   * youtube.com bloqueado, a pesquisa profunda ainda contatava o domínio.
   * Esta checagem é camada de renderer (quem abre o devtools contorna), mas
   * é a única que existe neste caminho e fecha o furo do uso normal.
   */
  const bloqueio = blockedUrl(useApp.getState().policy?.blockedDomains ?? [], url);
  if (bloqueio) return unverifiedSource(url, kind, blockedMessage(bloqueio));
  if (kind === "video") return collectYoutube(url);
  if (isTauriHost) {
    try {
      const page = await invoke<FetchedPage>("research_fetch", { url });
      return {
        source: {
          url,
          title: page.title.trim() || hostLabel(url),
          kind,
          credibility: 0.5,
          summary: "Conteúdo coletado — avaliação pendente."
        },
        excerpt: page.text.slice(0, 1600),
        verified: true
      };
    } catch {
      return unverifiedSource(url, kind, "a coleta pelo app desktop falhou (rede ou comando)");
    }
  }
  return unverifiedSource(url, kind, "requer o app desktop para ler o conteúdo");
}

export async function runResearch(
  question: string,
  ask: (messages: ChatMessage[]) => Promise<string>,
  events: ResearchEvents
): Promise<ResearchReport> {
  events.onStage?.("Pesquisa · planejando consultas");
  const plannerRaw = await ask([
    { role: "system", content: PLANNER_PROMPT },
    { role: "user", content: question }
  ]);
  const candidates = candidateUrls(question, plannerRaw);

  const gathered: GatheredSource[] = [];
  for (let index = 0; index < candidates.length; index += 1) {
    events.onStage?.(`Pesquisa · lendo fonte ${index + 1}/${candidates.length}`);
    gathered.push(await collectSource(candidates[index]));
  }

  events.onStage?.("Pesquisa · avaliando credibilidade");
  const listing = gathered
    .map((item, index) => {
      const body = item.excerpt
        ? `Trecho:\n${item.excerpt}`
        : "(sem conteúdo verificado — a coleta real não estava disponível)";
      return `[${index + 1}] ${item.source.title} — ${item.source.url} (${item.source.kind})\n${body}`;
    })
    .join("\n\n");
  const evaluationRaw = await ask([
    { role: "system", content: EVALUATOR_PROMPT },
    { role: "user", content: `Pergunta:\n${question}\n\nFontes coletadas:\n${listing}` }
  ]);

  events.onStage?.("Pesquisa · sintetizando com citações");
  const payload = extractJsonObject(evaluationRaw);
  const sources = gathered.map((item) => ({ ...item.source }));

  for (const evaluation of payload?.evaluations ?? []) {
    const index = typeof evaluation.index === "number" ? Math.round(evaluation.index) - 1 : -1;
    const target = sources[index];
    if (!target) continue;
    const verified = gathered[index].verified;
    if (typeof evaluation.credibility === "number") {
      const credibility = clamp01(evaluation.credibility);
      target.credibility = verified ? credibility : Math.min(credibility, 0.35);
    }
    if (verified && typeof evaluation.summary === "string" && evaluation.summary.trim()) {
      target.summary = evaluation.summary.trim();
    }
  }

  const anyVerified = gathered.some((item) => item.verified);
  const rawSynthesis = payload?.synthesis;
  const synthesis =
    typeof rawSynthesis === "string" && rawSynthesis.trim()
      ? rawSynthesis.trim()
      : `Não foi possível sintetizar automaticamente nesta execução. Use as fontes ${sources
          .map((_, index) => `[${index + 1}]`)
          .join(", ")} como ponto de partida e trate as conclusões como preliminares.`;

  const rawConfidence = payload?.confidence;
  let confidence = typeof rawConfidence === "number" ? clamp01(rawConfidence) : 0.35;
  if (!anyVerified) confidence = Math.min(confidence, 0.35);

  const rawOpenQuestions = payload?.openQuestions;
  const openQuestions = Array.isArray(rawOpenQuestions)
    ? rawOpenQuestions
        .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
        .map((entry) => entry.trim())
        .slice(0, 5)
    : [];
  if (!openQuestions.length && !anyVerified) {
    openQuestions.push("Reexecutar a pesquisa no aplicativo desktop para verificar as fontes de verdade.");
  }

  return { question, sources, synthesis, confidence, openQuestions };
}

/** Preâmbulo de sistema que ancora a resposta final nas fontes numeradas. */
export function researchSystemContext(report: ResearchReport): string {
  const sources = report.sources
    .map(
      (source, index) =>
        `[${index + 1}] ${source.title} — ${source.url} (${source.kind}, credibilidade ${Math.round(
          source.credibility * 100
        )}%): ${source.summary}`
    )
    .join("\n");
  const open = report.openQuestions.length ? `Questões em aberto: ${report.openQuestions.join("; ")}.` : "";
  return [
    `Contexto de pesquisa profunda para a pergunta: "${report.question}".`,
    `Fontes numeradas:\n${sources}`,
    `Síntese preliminar (com citações): ${report.synthesis}`,
    `Confiança geral estimada: ${Math.round(report.confidence * 100)}%. ${open}`.trim(),
    'Instrução: antes da resposta final, apresente "Confirmando entendimento: …" em 1 linha resumindo o que foi pedido; ' +
      "em seguida responda citando as fontes pelo índice [n] sempre que usar informação delas e sinalize explicitamente " +
      "afirmações apoiadas em fontes de credibilidade baixa."
  ].join("\n\n");
}
