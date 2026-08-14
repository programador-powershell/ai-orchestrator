import type { DesignReplicationRequest, DesignReplicationResult, Mode, OrchestrationGraph, OrchestrationPlan, WorkspaceSummary } from "@multiplike/contracts";

export interface GatewaySession {
  baseUrl: string;
  workspaceId: string;
  accessToken: string;
}

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

const ensureUrl = (value: string) => value.replace(/\/$/, "");

const isTauriHost = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/**
 * fetch autenticado com renovação: um 401 dispara o refresh no Rust
 * (`oidc_restore`, que renova quando o token venceu) UMA vez e repete a
 * chamada. Antes disso o app nunca renovava em execução — o token vencia no
 * meio do uso e toda chamada seguinte morria em 401 até reiniciar.
 */
async function authorizedFetch(
  session: { baseUrl: string; accessToken: string },
  input: string,
  init: RequestInit = {},
  extraHeaders: Record<string, string> = {}
): Promise<Response> {
  const attempt = (token: string) =>
    fetch(input, { ...init, headers: { ...extraHeaders, Authorization: `Bearer ${token}` } });
  const response = await attempt(session.accessToken);
  if (response.status !== 401 || !isTauriHost) return response;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    // `force`: o gateway já recusou o token. Sem isso, revogação e rotação de
    // chave não renovam — só a expiração por relógio renovava.
    const renewed = await invoke<{ accessToken: string } | null>("oidc_restore", {
      gatewayBaseUrl: session.baseUrl,
      force: true
    });
    if (!renewed || renewed.accessToken === session.accessToken) return response;
    // Atualiza a sessão viva para as chamadas seguintes não repetirem o 401.
    const { useApp } = await import("./store");
    const current = useApp.getState().session;
    if (current) useApp.getState().setSession({ ...current, accessToken: renewed.accessToken });
    return attempt(renewed.accessToken);
  } catch {
    return response;
  }
}

export async function listWorkspaces(session: Omit<GatewaySession, "workspaceId">) {
  const response = await authorizedFetch(session, `${ensureUrl(session.baseUrl)}/v1/workspaces`);
  if (!response.ok) throw new Error(`Gateway respondeu ${response.status}`);
  return (await response.json()) as WorkspaceSummary[];
}

export async function streamChat(
  session: GatewaySession,
  mode: Mode,
  messages: ChatMessage[],
  onDelta: (delta: string) => void,
  signal?: AbortSignal
) {
  const response = await authorizedFetch(
    session,
    `${ensureUrl(session.baseUrl)}/v1/workspaces/${session.workspaceId}/chat/completions`,
    { method: "POST", signal, body: JSON.stringify({ mode, stream: true, messages }) },
    { "Content-Type": "application/json", Accept: "text/event-stream" }
  );

  if (!response.ok || !response.body) {
    throw new Error((await response.text()) || `Gateway respondeu ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  /**
   * O stream chegou ao fim de verdade?
   *
   * `done` só diz que a conexão acabou. Um proxy que corta no meio (ou um
   * provedor que encerra o SSE limpo antes da hora) entregava o texto pela
   * metade como se fosse a resposta completa — falha silenciosa, a pior
   * delas. Os dois leitores irmãos do projeto (`engine.ts` e o
   * `providers.rs`) tratam exatamente isso como erro; esta rota tinha ficado
   * sem a proteção.
   */
  let terminou = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    const events = pending.split("\n\n");
    pending = events.pop() ?? "";
    for (const event of events) {
      const data = event
        .split("\n")
        .find((line) => line.startsWith("data:"))
        ?.slice(5)
        .trim();
      if (!data) continue;
      if (data === "[DONE]") {
        terminou = true;
        continue;
      }
      const parsed = JSON.parse(data) as {
        choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
      };
      if (parsed.choices?.[0]?.finish_reason) terminou = true;
      onDelta(parsed.choices?.[0]?.delta?.content ?? "");
    }
  }
  if (!terminou) {
    throw new StreamInterruptedError(
      "a resposta foi interrompida antes do fim — o texto acima está incompleto"
    );
  }
}

/** Stream cortado no meio: quem chama decide se refaz ou avisa. */
export class StreamInterruptedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StreamInterruptedError";
  }
}

/**
 * Geração de imagem pelo gateway (Imagen / Flux / OpenAI Images, conforme o
 * provedor configurado no workspace). Retorna URLs ou data-URLs base64.
 */
export async function generateImage(
  session: GatewaySession,
  prompt: string,
  signal?: AbortSignal
): Promise<string[]> {
  const response = await authorizedFetch(
    session,
    `${ensureUrl(session.baseUrl)}/v1/workspaces/${session.workspaceId}/images/generations`,
    { method: "POST", signal, body: JSON.stringify({ payload: { prompt } }) },
    { "Content-Type": "application/json" }
  );
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(detail || `Gateway respondeu ${response.status}`);
  }
  const payload = (await response.json()) as {
    data?: Array<{ url?: string; b64_json?: string }>;
  };
  return (payload.data ?? [])
    .map((item) => item.url ?? (item.b64_json ? `data:image/png;base64,${item.b64_json}` : ""))
    .filter(Boolean);
}

/**
 * Vetores de texto pelo gateway — a camada que dá SENTIDO à busca na memória.
 *
 * Devolve `null` (e não lança) quando o workspace não tem provedor com essa
 * capacidade: busca semântica é melhoria, não requisito. Derrubar a recuperação
 * de memória porque o admin não configurou embeddings seria trocar um recurso
 * ausente por uma falha visível.
 */
export async function embedTexts(
  session: GatewaySession,
  inputs: string[],
  signal?: AbortSignal
): Promise<number[][] | null> {
  if (!inputs.length) return [];
  try {
    const response = await authorizedFetch(
      session,
      `${ensureUrl(session.baseUrl)}/v1/workspaces/${session.workspaceId}/embeddings`,
      { method: "POST", signal, body: JSON.stringify({ payload: { input: inputs } }) },
      { "Content-Type": "application/json" }
    );
    if (!response.ok) return null;
    const payload = (await response.json()) as { data?: Array<{ embedding?: number[]; index?: number }> };
    const data = payload.data ?? [];
    if (data.length !== inputs.length) return null;
    // A ordem do retorno não é garantida por todos os provedores; quando vem
    // `index`, ele manda — senão, um vetor iria para a memória errada.
    const saida: number[][] = new Array(inputs.length);
    data.forEach((entry, posicao) => {
      const alvo = typeof entry.index === "number" ? entry.index : posicao;
      if (alvo >= 0 && alvo < inputs.length && Array.isArray(entry.embedding)) {
        saida[alvo] = entry.embedding;
      }
    });
    return saida.every((vetor) => Array.isArray(vetor) && vetor.length > 0) ? saida : null;
  } catch {
    return null;
  }
}

export async function replicateDesign(
  session: GatewaySession,
  request: DesignReplicationRequest,
  signal?: AbortSignal
) {
  const response = await authorizedFetch(
    session,
    `${ensureUrl(session.baseUrl)}/v1/workspaces/${session.workspaceId}/design/replications`,
    { method: "POST", signal, body: JSON.stringify(request) },
    { "Content-Type": "application/json" }
  );
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
    throw new Error(payload?.error?.message || `Gateway respondeu ${response.status}`);
  }
  return (await response.json()) as DesignReplicationResult;
}

export async function validateOrchestration(
  session: GatewaySession,
  graph: OrchestrationGraph,
  signal?: AbortSignal
) {
  const response = await authorizedFetch(
    session,
    `${ensureUrl(session.baseUrl)}/v1/workspaces/${session.workspaceId}/orchestrations/validate`,
    { method: "POST", signal, body: JSON.stringify(graph) },
    { "Content-Type": "application/json" }
  );
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
    throw new Error(payload?.error?.message || `Gateway respondeu ${response.status}`);
  }
  return (await response.json()) as OrchestrationPlan;
}
