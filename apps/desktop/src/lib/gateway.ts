import type { DesignReplicationRequest, DesignReplicationResult, Mode, OrchestrationGraph, OrchestrationPlan, WorkspaceSummary } from "@ai-orchestrator/contracts";

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

export async function listWorkspaces(session: Omit<GatewaySession, "workspaceId">) {
  const response = await fetch(`${ensureUrl(session.baseUrl)}/v1/workspaces`, {
    headers: { Authorization: `Bearer ${session.accessToken}` }
  });
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
  const response = await fetch(
    `${ensureUrl(session.baseUrl)}/v1/workspaces/${session.workspaceId}/chat/completions`,
    {
      method: "POST",
      signal,
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream"
      },
      body: JSON.stringify({ mode, stream: true, messages })
    }
  );

  if (!response.ok || !response.body) {
    throw new Error((await response.text()) || `Gateway respondeu ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
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
      if (!data || data === "[DONE]") continue;
      const parsed = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> };
      onDelta(parsed.choices?.[0]?.delta?.content ?? "");
    }
  }
}

export async function replicateDesign(
  session: GatewaySession,
  request: DesignReplicationRequest,
  signal?: AbortSignal
) {
  const response = await fetch(
    `${ensureUrl(session.baseUrl)}/v1/workspaces/${session.workspaceId}/design/replications`,
    {
      method: "POST",
      signal,
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(request)
    }
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
  const response = await fetch(
    `${ensureUrl(session.baseUrl)}/v1/workspaces/${session.workspaceId}/orchestrations/validate`,
    {
      method: "POST",
      signal,
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(graph)
    }
  );
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
    throw new Error(payload?.error?.message || `Gateway respondeu ${response.status}`);
  }
  return (await response.json()) as OrchestrationPlan;
}
