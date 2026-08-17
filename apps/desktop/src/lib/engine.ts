/**
 * Motor de execução unificado — "flexibilidade de fornecedor".
 *
 * Uma única função `chatOnce` resolve a EngineSelection ativa:
 *  - workspace  → gateway (streaming SSE)
 *  - local      → runtime GGUF local (llama.cpp)
 *  - model      → provedor direto via comando Rust (chave fica no keyring, nunca no JS)
 *  - fusion     → orquestrador + executores (orchestrate/merge/race), client-side
 *
 * Sem nenhuma conexão, cai em modo demonstração claramente rotulado, para que a
 * interface continue navegável e verificável.
 */
import { Channel, invoke } from "@tauri-apps/api/core";
import { MODES, type EngineSelection, type FusionPreset, type Mode, type ModelTarget, type UiMode } from "@ai-bot/contracts";
import { byok, providerExtraHeaders } from "./byok";
import {
  buildBriefRequest,
  buildDecomposeRequest,
  buildExecuteFusionRequest,
  buildIntegrateRequest,
  buildReviewRequest,
  buildSubtaskRequest,
  fallbackSubtasks,
  fusionRolePolicy,
  parseSubtasks
} from "./fusionPrompts";
import { buildAdaptivePlanRequest, fallbackPlan, parseFusionPlan } from "./fusionPlan";
import { resolvePresetForMode } from "./fusionResolve";
import { selecaoEfetiva, type ContextoDePolitica } from "./enginePolicy";
import { streamChat, type ChatMessage, type GatewaySession } from "./gateway";
import { runtime } from "./runtime";
import { parseSseLine } from "./sseDelta";

const isTauriHost = "__TAURI_INTERNALS__" in window;

export interface EngineContext {
  session: GatewaySession | null;
  runtimeRunning: boolean;
  fusionPresets: FusionPreset[];
  /**
   * A política do admin, para o portão de `local` e `model`.
   *
   * Opcional porque nem todo chamador tem contexto de política (teste,
   * caminho interno). Ausente = comporta-se como antes, sem restrição — o
   * aperto só existe quando quem chama informa que HÁ um gateway.
   */
  politica?: ContextoDePolitica;
  /** Base URLs custom por provedor (compatíveis/self-hosted), vindas do Settings. */
  baseOverrides?: Record<string, string>;
}

export function resolveBaseUrl(providerId: string, overrides?: Record<string, string>): string {
  const override = overrides?.[providerId]?.trim();
  if (override) return override.replace(/\/$/, "");
  return providerBaseUrls[providerId] ?? providerBaseUrls["openai-compatible"];
}

/**
 * A base pode receber a chave BYOK?
 *
 * Mesma regra que o Rust aplica em `validate_base_url`: `http://` só para a
 * própria máquina. O caminho web não tinha o equivalente — com um override
 * `http://host/v1` (provedor compatível self-hosted), o `Authorization:
 * Bearer <chave>` saía em texto claro na rede, exatamente o que o lado
 * desktop recusa por construção.
 */
export function assertBaseUrlSegura(baseUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(`Base URL inválida: ${baseUrl}`);
  }
  if (parsed.username || parsed.password) {
    throw new Error("Base URL com usuário/senha embutidos não é aceita.");
  }
  if (parsed.protocol === "https:") return;
  const loopback = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(parsed.hostname);
  if (parsed.protocol === "http:" && loopback) return;
  throw new Error(
    "A chave do provedor não trafega em http:// fora da própria máquina. Use https:// na base URL."
  );
}

export interface EngineEvents {
  onDelta: (delta: string) => void;
  /** Notas de progresso do fusion/pesquisa ("orquestrador planejando…"). */
  onStage?: (stage: string) => void;
  /** Bloco de raciocínio do modelo (mostrado recolhido, separado da resposta). */
  onReasoning?: (delta: string) => void;
  /** Plano do orquestrador: complexidade e executores escolhidos (cartão). */
  onFusionPlan?: (plan: { complexity: number; executors: Array<{ role: string; focus: string; model: string }> }) => void;
  /**
   * Aviso do MOTOR para a tela — hoje só a política que trocou a rota.
   *
   * Separado de `onStage`: estágio é progresso e some; isto é uma decisão que
   * mudou o que a pessoa pediu, e precisa ficar visível.
   */
  onNotice?: (mensagem: string) => void;
  /** Executor terminou seu recorte (atualiza o cartão em tempo real). */
  onFusionExecutor?: (role: string, status: "running" | "ok" | "error") => void;
}

const DEMO_NOTE =
  "— modo demonstração: conecte o gateway, um provedor (BYOK) ou o runtime local em Configurações —\n\n";

/** Nomes de conta no keyring por provedor. A chave nunca transita pelo JS. */
export const providerBaseUrls: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  /** Camada de compatibilidade OpenAI da Anthropic (Bearer + /chat/completions). */
  anthropic: "https://api.anthropic.com/v1",
  moonshot: "https://api.moonshot.ai/v1",
  deepseek: "https://api.deepseek.com/v1",
  mistral: "https://api.mistral.ai/v1",
  openrouter: "https://openrouter.ai/api/v1",
  "openai-compatible": ""
};

export interface CatalogLabel {
  providerId: string;
  model: string;
  label?: string;
}

/** Nome amigável do modelo (rótulo do catálogo quando houver; senão o id). */
export function modelLabel(target: ModelTarget, catalog?: CatalogLabel[]): string {
  const entry = catalog?.find((item) => item.providerId === target.providerId && item.model === target.model);
  return entry?.label ?? target.model;
}

/** Modelos que o preset funde — ex.: "GPT-5.1 + Kimi + DeepSeek Chat". */
export function fusionModels(preset: FusionPreset, catalog?: CatalogLabel[]): string {
  const targets =
    preset.strategy === "orchestrate"
      ? [preset.executors[0] ?? preset.orchestrator, preset.orchestrator]
      : preset.executors;
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const target of targets) {
    const label = modelLabel(target, catalog);
    if (!seen.has(label)) {
      seen.add(label);
      labels.push(label);
    }
  }
  return labels.join(" + ");
}

export function describeSelection(
  selection: EngineSelection,
  presets: FusionPreset[],
  catalog?: CatalogLabel[]
): string {
  switch (selection.kind) {
    case "workspace":
      return "Rota do workspace";
    case "local":
      return "Runtime local";
    case "model":
      return `${selection.target.providerId} · ${selection.target.model}`;
    case "fusion": {
      const preset = presets.find((item) => item.id === selection.presetId);
      if (!preset) return "Fusion";
      return `${preset.name} · ${fusionModels(preset, catalog)}`;
    }
  }
}

async function demoStream(messages: ChatMessage[], events: EngineEvents, signal?: AbortSignal): Promise<string> {
  const last = messages.at(-1)?.content ?? "";
  const body =
    `${DEMO_NOTE}Recebi: "${last.slice(0, 160)}"\n\n` +
    "Neste modo eu não chamo nenhum modelo. Tudo o mais funciona: memória, planos, " +
    "diagramas, diffs e orquestração. Configure um motor para respostas reais.";
  let output = "";
  for (const chunk of body.match(/.{1,14}/gs) ?? []) {
    if (signal?.aborted) break;
    output += chunk;
    events.onDelta(chunk);
    await new Promise((resolve) => setTimeout(resolve, 12));
  }
  return output;
}

async function providerChat(
  target: ModelTarget,
  messages: ChatMessage[],
  events: EngineEvents,
  overrides?: Record<string, string>,
  signal?: AbortSignal
): Promise<string> {
  events.onStage?.(`${target.providerId}/${target.model}`);
  const baseUrl = resolveBaseUrl(target.providerId, overrides);
  if (!baseUrl) throw new Error(`Configure a base URL do provedor "${target.providerId}" em Configurações → Provedores.`);

  if (isTauriHost) {
    // Streaming real: os deltas chegam pelo Channel conforme o provedor envia,
    // em vez de esperar a resposta inteira. A chave nunca sai do keyring (Rust).
    const channel = new Channel<StreamEvent>();
    const streamId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
    let streamed = "";
    let aborted = false;
    channel.onmessage = (event) => {
      // Após o Parar, deltas em trânsito não entram mais na conversa.
      if (aborted) return;
      if (event.kind === "reasoning") {
        events.onReasoning?.(event.data);
        return;
      }
      if (event.kind !== "delta") return;
      streamed += event.data;
      events.onDelta(event.data);
    };
    // Botão Parar: manda o Rust encerrar o consumo do provedor (para de gastar
    // tokens) e libera o turno imediatamente no front.
    const onAbort = () => {
      aborted = true;
      void invoke("provider_chat_cancel", { streamId }).catch(() => undefined);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      if (signal?.aborted) throw new DOMException("cancelado", "AbortError");
      const full = await invoke<string>("provider_chat_stream", {
        request: {
          baseUrl,
          account: `provider:${target.providerId}`,
          model: target.model,
          messages,
          streamId
        },
        onEvent: channel
      });
      if (aborted) return streamed;
      // O retorno é a fonte da verdade; se o Channel não entregou nada (build
      // antiga), emite de uma vez para não deixar a bolha vazia.
      if (!streamed && full) events.onDelta(full);
      return full;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  // Navegador: chamada direta com a chave do armazenamento local (BYOK web).
  // A base é checada ANTES de ler a chave — nem carregar o segredo faz
  // sentido se o destino não pode recebê-lo.
  assertBaseUrlSegura(baseUrl);
  const key = await byok.readForWebCall(target.providerId);
  if (!key) {
    throw new Error(
      `Sem chave para "${target.providerId}". Adicione em Configurações → Provedores (no navegador ela fica neste perfil; prefira o app desktop).`
    );
  }
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
      Accept: "text/event-stream",
      ...providerExtraHeaders(target.providerId)
    },
    body: JSON.stringify({ model: target.model, messages, stream: true })
  });
  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => "");
    throw new Error(`${target.providerId} respondeu ${response.status}: ${detail.slice(0, 300)}`);
  }
  const content = await readSseStream(response.body, events.onDelta, events.onReasoning);
  if (!content) throw new Error(`${target.providerId} não retornou conteúdo.`);
  return content;
}

interface StreamEvent {
  kind: "delta" | "reasoning" | "done";
  data: string;
}

/** Resposta cortada pelo provedor no meio do stream (sem sinal de término). */
export class StreamInterruptedError extends Error {
  constructor(readonly partial: string) {
    super("a resposta foi interrompida antes de terminar — o provedor cortou o stream");
    this.name = "StreamInterruptedError";
  }
}

/**
 * Lê um corpo SSE de chat/completions, separando resposta e raciocínio.
 *
 * EOF sem `[DONE]` nem `finish_reason` NÃO é sucesso: significa conexão cortada
 * no meio. Tratar como sucesso entregaria texto truncado como se fosse a
 * resposta completa.
 */
export async function readSseStream(
  body: ReadableStream<Uint8Array>,
  onDelta: (delta: string) => void,
  onReasoning?: (delta: string) => void
): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let full = "";
  let sawTerminal = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    // Enquadra por linha em branco, tolerante a CRLF (provedores variam).
    const events = pending.split(/\r?\n\r?\n/);
    pending = events.pop() ?? "";
    for (const event of events) {
      const data = event
        .split(/\r?\n/)
        .find((line) => line.startsWith("data:"))
        ?.slice(5)
        .trim();
      if (!data) continue;
      if (data === "[DONE]") {
        sawTerminal = true;
        continue;
      }
      const parsed = parseSseLine(data);
      if (!parsed) continue;
      if (parsed.finishReason) sawTerminal = true;
      if (parsed.reasoning) onReasoning?.(parsed.reasoning);
      if (parsed.content) {
        full += parsed.content;
        onDelta(parsed.content);
      }
    }
  }
  if (!sawTerminal) throw new StreamInterruptedError(full);
  return full;
}

async function singleTurn(
  backend: "workspace" | "local" | "model",
  target: ModelTarget | null,
  mode: Mode | UiMode,
  messages: ChatMessage[],
  ctx: EngineContext,
  events: EngineEvents,
  signal?: AbortSignal
): Promise<string> {
  if (backend === "workspace") {
    if (!ctx.session?.accessToken || !ctx.session.workspaceId) return demoStream(messages, events, signal);
    // O modo vai INTACTO ao gateway. A reescrita antiga (office/tune viravam
    // "chat") impedia o servidor de bloquear por módulo: ele nunca via o
    // módulo real. Se um modo não existir no contrato, o erro do servidor é a
    // resposta certa — não uma rota disfarçada.
    const wireMode: Mode = mode as Mode;
    if (!(MODES as readonly string[]).includes(mode)) {
      throw new Error(`modo "${mode}" fora do contrato do gateway`);
    }
    let output = "";
    await streamChat(
      ctx.session,
      wireMode,
      messages,
      (delta) => {
        output += delta;
        events.onDelta(delta);
      },
      signal
    );
    return output;
  }
  if (backend === "local") {
    if (!ctx.runtimeRunning) return demoStream(messages, events, signal);
    // Streaming real do llama.cpp local (antes vinha tudo de uma vez).
    let streamed = "";
    /**
     * "Parar" para de PINTAR na hora, e o turno é liberado.
     *
     * O runtime local não expõe cancelamento (não existe
     * `runtime_chat_cancel`, e o `pump_sse` do Rust é a variante sem
     * `stream_id`), então a geração segue até o modelo terminar sozinho — mas
     * antes o botão não fazia nem isso: os tokens continuavam chegando na
     * bolha e o `sending` só liberava no fim. As rotas de provedor e de
     * gateway cancelam de verdade; esta é a única que não, e o limite fica
     * dito aqui em vez de virar um botão que engana.
     */
    const cancelado = () => signal?.aborted === true;
    try {
      const full = await runtime.chatStream(messages, (delta) => {
        if (cancelado()) return;
        streamed += delta;
        events.onDelta(delta);
      });
      if (cancelado()) return streamed;
      if (!streamed && full) events.onDelta(full);
      return full || streamed;
    } catch {
      // Build antiga sem o comando de stream: cai no caminho não-streaming.
      const response = await runtime.chat(messages);
      if (cancelado()) return streamed;
      const content = response.choices?.[0]?.message?.content ?? "O runtime não retornou conteúdo.";
      events.onDelta(content);
      return content;
    }
  }
  if (!target) throw new Error("Modelo não informado.");
  return providerChat(target, messages, events, ctx.baseOverrides, signal);
}

/** Chamada silenciosa (sem stream na UI) usada nas etapas INTERMEDIÁRIAS do fusion. */
async function quietTurn(
  target: ModelTarget | "workspace",
  mode: Mode | UiMode,
  messages: ChatMessage[],
  ctx: EngineContext,
  signal?: AbortSignal
): Promise<string> {
  const sink: EngineEvents = { onDelta: () => undefined };
  if (target === "workspace") return singleTurn("workspace", null, mode, messages, ctx, sink, signal);
  try {
    return await providerChat(target, messages, sink, ctx.baseOverrides, signal);
  } catch {
    // Sem chave/desktop: usa a rota do workspace como melhor esforço.
    return singleTurn("workspace", null, mode, messages, ctx, sink, signal);
  }
}

/**
 * Turno que TRANSMITE na UI — usado na etapa FINAL do fusion, para a resposta
 * aparecer token a token (conversa natural) em vez de surgir pronta no fim.
 */
async function streamingTurn(
  target: ModelTarget | "workspace",
  mode: Mode | UiMode,
  messages: ChatMessage[],
  ctx: EngineContext,
  events: EngineEvents,
  signal?: AbortSignal
): Promise<string> {
  if (target === "workspace") return singleTurn("workspace", null, mode, messages, ctx, events, signal);
  try {
    return await providerChat(target, messages, events, ctx.baseOverrides, signal);
  } catch {
    return singleTurn("workspace", null, mode, messages, ctx, events, signal);
  }
}

/**
 * Fusion de produção — cooperação SEM sobreposição (ver lib/fusionPrompts.ts):
 *  - orchestrate: orquestrador especifica → executor produz → orquestrador
 *    revisa por conformidade (proibido reescrever do zero).
 *  - merge: orquestrador DECOMPÕE em focos complementares (um por executor),
 *    executores trabalham em recortes exclusivos, orquestrador integra.
 *  - race: latência mínima — primeiro executor a responder vence.
 * Políticas por aba: security = menos salvaguarda orquestra / restrito executa;
 * code = inteligente orquestra / barato executa.
 */
async function fusionTurn(
  preset: FusionPreset,
  mode: Mode | UiMode,
  messages: ChatMessage[],
  ctx: EngineContext,
  events: EngineEvents,
  signal?: AbortSignal
): Promise<string> {
  const question = messages.at(-1)?.content ?? "";
  const policy = fusionRolePolicy(mode);
  const roleTag = policy.policy === "safeguard" ? "salvaguarda" : policy.policy === "cost" ? "custo" : "capacidade";
  /**
   * Contexto da conversa (system com memória/instruções + histórico), SEM a
   * última pergunta — os builders do fusion já a incluem. Prefixar isto em cada
   * sub-chamada evita que o fusion "esqueça" a conversa: sem ele, cada etapa via
   * só a pergunta isolada e trocar de modelo parecia recomeçar do zero.
   */
  const context = messages.slice(0, -1);
  const withContext = (built: ChatMessage[]): ChatMessage[] => [...context, ...built];

  if (preset.strategy === "race") {
    events.onStage?.("Fusion · race — primeiro executor a responder vence");
    // Vence quem EMITE primeiro: os deltas do vencedor passam direto para a UI
    // (conversa natural); os demais são descartados sem poluir a bolha.
    let winnerIndex = -1;
    const attempts = preset.executors.map((executor, index) =>
      streamingTurn(
        executor,
        mode,
        messages,
        ctx,
        {
          onDelta: (delta) => {
            if (winnerIndex === -1) winnerIndex = index;
            if (winnerIndex === index) events.onDelta(delta);
          },
          onStage: events.onStage
        },
        signal
      )
    );
    const settled = await Promise.allSettled(attempts);
    const chosen = winnerIndex >= 0 ? settled[winnerIndex] : settled.find((r) => r.status === "fulfilled");
    const winner = chosen?.status === "fulfilled" ? chosen.value : "";
    if (!winner) events.onDelta("Nenhum executor respondeu.");
    return winner;
  }

  if (preset.strategy === "merge") {
    // 1) O ORQUESTRADOR decide a complexidade e QUANTOS executores acionar —
    //    pergunta simples não gasta o painel inteiro.
    const maxExecutors = Math.max(1, preset.executors.length);
    events.onStage?.(`Fusion (${roleTag}) · ${preset.orchestrator.model} planejando`);
    const planText = await quietTurn(
      preset.orchestrator,
      mode,
      withContext(buildAdaptivePlanRequest(mode, question, maxExecutors)),
      ctx,
      signal
    );
    const plan = parseFusionPlan(planText, maxExecutors) ?? fallbackPlan(question, maxExecutors);
    // Painel efetivo: um modelo por executor planejado (cicla se faltar modelo).
    const panel = plan.executors.map((spec, index) => ({
      spec,
      target: preset.executors[index % preset.executors.length] ?? preset.orchestrator
    }));
    events.onFusionPlan?.({
      complexity: plan.complexity,
      executors: panel.map((item) => ({ role: item.spec.role, focus: item.spec.focus, model: item.target.model }))
    });

    // Complexidade baixa com 1 executor: responde direto, em streaming — sem
    // pagar decomposição + integração para uma pergunta simples.
    if (panel.length === 1) {
      events.onStage?.(`Fusion (${roleTag}) · resposta direta (${panel[0].target.model})`);
      events.onFusionExecutor?.(panel[0].spec.role, "running");
      const direct = await streamingTurn(panel[0].target, mode, messages, ctx, events, signal);
      events.onFusionExecutor?.(panel[0].spec.role, direct ? "ok" : "error");
      return direct;
    }

    // 2) Execução paralela: cada executor SOMENTE no seu recorte.
    events.onStage?.(`Fusion (${roleTag}) · ${panel.length} executores em focos exclusivos`);
    for (const item of panel) events.onFusionExecutor?.(item.spec.role, "running");
    const results = await Promise.allSettled(
      panel.map((item, index) =>
        quietTurn(
          item.target,
          mode,
          withContext(buildSubtaskRequest(mode, question, item.spec.focus, index, panel.length)),
          ctx,
          signal
        ).then((value) => {
          events.onFusionExecutor?.(item.spec.role, value ? "ok" : "error");
          return value;
        })
      )
    );
    const parts = results
      .map((result, index) =>
        result.status === "fulfilled" && result.value
          ? { focus: `${panel[index].spec.role} — ${panel[index].spec.focus}`, content: result.value }
          : null
      )
      .filter((part): part is { focus: string; content: string } => part !== null);
    for (const [index, result] of results.entries()) {
      if (result.status === "rejected") events.onFusionExecutor?.(panel[index].spec.role, "error");
    }
    if (!parts.length) return demoStream(messages, events, signal);

    // 3) Integração: costura sem reescrever — TRANSMITIDA token a token na UI.
    events.onStage?.(`Fusion (${roleTag}) · ${preset.orchestrator.model} integrando ${parts.length} partes`);
    const fallback = parts.map((part) => part.content).join("\n\n");
    const integrated = await streamingTurn(
      preset.orchestrator,
      mode,
      withContext(buildIntegrateRequest(mode, question, parts)),
      ctx,
      events,
      signal
    );
    if (!integrated) events.onDelta(fallback);
    return integrated || fallback;
  }

  // orchestrate: especifica → produz → revisa por conformidade.
  // Orquestrador == executor (mesmo modelo) não ganha nada com 3 idas: responde
  // direto, transmitindo desde o primeiro token.
  const soloExecutor = preset.executors[0] ?? preset.orchestrator;
  const sameModel =
    preset.executors.length <= 1 &&
    soloExecutor.providerId === preset.orchestrator.providerId &&
    soloExecutor.model === preset.orchestrator.model;
  if (sameModel) {
    events.onStage?.(`Fusion (${roleTag}) · ${preset.orchestrator.model}`);
    return streamingTurn(preset.orchestrator, mode, messages, ctx, events, signal);
  }

  events.onStage?.(`Fusion (${roleTag}) · ${preset.orchestrator.model} especificando`);
  const brief = await quietTurn(preset.orchestrator, mode, withContext(buildBriefRequest(mode, question)), ctx, signal);
  const executor = soloExecutor;
  events.onStage?.(`Fusion (${roleTag}) · ${executor.model} executando a spec`);
  const draft = await quietTurn(executor, mode, buildExecuteFusionRequest(mode, brief, messages), ctx, signal);
  // Revisão final TRANSMITIDA — é o texto que o usuário lê aparecendo ao vivo.
  events.onStage?.(`Fusion (${roleTag}) · ${preset.orchestrator.model} revisando conformidade`);
  const final = await streamingTurn(
    preset.orchestrator,
    mode,
    withContext(buildReviewRequest(mode, question, draft)),
    ctx,
    events,
    signal
  );
  if (!final) events.onDelta(draft);
  return final || draft;
}

export async function chatOnce(
  selection: EngineSelection,
  mode: Mode | UiMode,
  messages: ChatMessage[],
  ctx: EngineContext,
  events: EngineEvents,
  signal?: AbortSignal
): Promise<string> {
  /*
   * O portão fica AQUI, e não só na lista suspensa.
   *
   * A escolha de motor é persistida em `settings.engines[aba]`: quem
   * selecionou "chave própria" antes de o admin desligar o BYOK continuava
   * usando a chave própria, porque o menu apenas escondia a opção e ninguém
   * revalidava a que já estava gravada. E `local`/`model` não passam pelo
   * gateway — sem esta checagem, as duas coisas que a política proíbe são
   * justamente as que ficam sem portão nenhum.
   *
   * Recusar seria pior que corrigir: cai para a rota do workspace e avisa.
   */
  if (ctx.politica) {
    const permitida = selecaoEfetiva(selection, ctx.politica);
    if (permitida.aviso) {
      events.onNotice?.(permitida.aviso);
      selection = permitida.selection;
    }
  }

  switch (selection.kind) {
    case "workspace":
      return singleTurn("workspace", null, mode, messages, ctx, events, signal);
    case "local":
      return singleTurn("local", null, mode, messages, ctx, events, signal);
    case "model":
      try {
        return await singleTurn("model", selection.target, mode, messages, ctx, events, signal);
      } catch (cause) {
        if (ctx.session?.accessToken) return singleTurn("workspace", null, mode, messages, ctx, events, signal);
        throw cause;
      }
    case "fusion": {
      const preset = ctx.fusionPresets.find((item) => item.id === selection.presetId);
      if (!preset) throw new Error("Preset de fusion não encontrado.");
      // Modelos específicos da atividade (aba) sobrepõem o preset base.
      return fusionTurn(resolvePresetForMode(preset, mode), mode, messages, ctx, events, signal);
    }
  }
}
