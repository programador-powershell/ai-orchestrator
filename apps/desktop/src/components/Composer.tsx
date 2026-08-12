/**
 * Composer compartilhado — presente em TODAS as abas, com a mesma geometria.
 * Input de chat, modo planejamento, seleção de motor (workspace/local/modelo/fusion)
 * e pesquisa profunda no Chat. Injeta memória persistente em qualquer motor.
 */
import { useEffect, useRef, useState, type ClipboardEvent } from "react";
import {
  CircleStop,
  Globe2,
  ListChecks,
  Paperclip,
  Send,
  Sparkles,
  ShieldCheck,
  Telescope,
  Wrench,
  X
} from "lucide-react";
import type { ExecutionPlan } from "@ai-orchestrator/contracts";
import type { ChatMessage } from "../lib/gateway";
import { chatOnce, describeSelection, type EngineContext } from "../lib/engine";
import {
  agentSystemInstruction,
  dispatchTool,
  runAgentLoop,
  type ToolCall
} from "../lib/agent";
import { applyResult, toolDetail } from "../lib/toolcard";
import { buildToolEdit } from "../lib/toolEdit";
import { policyLabel, requiresPrompt } from "../lib/approval";
import { fsRead } from "../lib/fsx";
import { filesFromClipboard } from "../lib/paste";
import { fileToDataUrl, toAttachmentDataUrl } from "../lib/imageAttach";
import { buildSummaryRequest, compactionNotice, planCompaction } from "../lib/compact";
import { createStreamBuffer } from "../lib/streamBuffer";
import { diagnosticCommand, formatDiagnostics } from "../lib/diagnostics";
import { McpHttpClient, mcpToolsToSpecs, parseNamespaced } from "../lib/mcp";
import { extractMemoryCandidates, memory, memoryPreamble } from "../lib/memory";
import { composerBus, opsBus, opsInstruction, type ComposerSendOptions } from "../lib/ops";
import { DEFAULT_COMMANDS, expandCommand } from "../lib/commands";
import { opsCatalogs, opsChannelForMode } from "../lib/opsCatalogs";
import { buildExecuteRequest, buildPlanRequest, parsePlan } from "../lib/planner";
import { effortDirective, useApp, type Attachment } from "../lib/store";
import { EffortSlider } from "./EffortSlider";
import { PlanCard } from "./PlanCard";

const modePlaceholders: Record<string, string> = {
  chat: "Pergunte, pesquise ou pense junto…",
  code: "Descreva a mudança de código…",
  design: "Descreva a interface ou cole uma URL para replicar…",
  data: "Peça tabelas, relações ou migrações…",
  work: "Descreva o objetivo ou a automação…",
  security: "Peça uma revisão, simulação ou correção…",
  agent: "Descreva o fluxo de agentes…",
  game: "Descreva a cena, o asset ou a lógica de gameplay…",
  tune: "Peça exemplos de dataset, config de treino ou avaliação…"
};

export function Composer() {
  const mode = useApp((state) => state.mode);
  const input = useApp((state) => state.input);
  const setInput = useApp((state) => state.setInput);
  const planMode = useApp((state) => state.planMode);
  const setPlanMode = useApp((state) => state.setPlanMode);
  const researchMode = useApp((state) => state.researchMode);
  const setResearchMode = useApp((state) => state.setResearchMode);
  const toolsMode = useApp((state) => state.toolsMode);
  const setToolsMode = useApp((state) => state.setToolsMode);
  const setSettingsOpen = useApp((state) => state.setSettingsOpen);
  const settings = useApp((state) => state.settings);
  const session = useApp((state) => state.session);
  const runtimeStatus = useApp((state) => state.runtimeStatus);
  const thread = useApp((state) => state.threads[state.mode]);
  const activePlan = useApp((state) => state.activePlan);
  const setActivePlan = useApp((state) => state.setActivePlan);
  const error = useApp((state) => state.error);
  const setError = useApp((state) => state.setError);
  const setStage = useApp((state) => state.setStage);
  const setResearchReport = useApp((state) => state.setResearchReport);
  const attachments = useApp((state) => state.attachments);
  const setAttachments = useApp((state) => state.setAttachments);
  const { appendMessage, patchLastAssistant, patchLastReasoning, replaceLastAssistant, setSending, updateToolGroup } =
    useApp.getState();

  const [executingPlan, setExecutingPlan] = useState(false);
  const [pendingApproval, setPendingApproval] = useState<{ call: ToolCall; resolve: (ok: boolean) => void } | null>(null);
  const abortRef = useRef<AbortController | undefined>(undefined);
  /** Um grupo de tool calls por turno agêntico (cartão recolhível). */
  const toolGroupOpenRef = useRef(false);
  const planSourceRef = useRef("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const selection = settings.engines[mode];

  useEffect(() => {
    textareaRef.current?.focus();
  }, [mode]);

  useEffect(
    () =>
      composerBus.register((text, options) => {
        void send(text, options);
      }),
    // send captura o estado atual via getState/closures a cada registro
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mode, planMode, researchMode, toolsMode, settings, session, runtimeStatus]
  );

  /** Carrega arquivos como anexo: binário vira data URL, texto vira conteúdo. */
  async function loadAttachments(files: File[]): Promise<Attachment[]> {
    return Promise.all(
      files.slice(0, 5).map(async (file) => {
        if (file.type.startsWith("image/")) {
          return { name: file.name, content: "", dataUrl: await toAttachmentDataUrl(file), mime: file.type };
        }
        if (file.type.startsWith("text/") || file.type === "application/json" || !file.type) {
          return { name: file.name, content: (await file.text()).slice(0, 60_000), mime: file.type };
        }
        // Vídeo/áudio/PDF: guarda o binário; o modelo recebe pelo menos o nome.
        return { name: file.name, content: "", dataUrl: await fileToDataUrl(file), mime: file.type };
      })
    );
  }

  async function attachFiles(files: FileList | null) {
    if (!files?.length) return;
    const loaded = await loadAttachments([...files]);
    setAttachments([...attachments, ...loaded].slice(0, 5));
  }

  /** Ctrl+V com imagem/vídeo/arquivo: vira anexo em vez de ser ignorado. */
  async function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const pasted = filesFromClipboard(event.clipboardData);
    if (!pasted.length) return; // texto puro segue o caminho normal
    event.preventDefault();
    const loaded = await loadAttachments(pasted.map((item) => new File([item.file], item.name, { type: item.type })));
    setAttachments([...useApp.getState().attachments, ...loaded].slice(0, 5));
  }

  const ctx: EngineContext = {
    session,
    runtimeRunning: runtimeStatus.running,
    fusionPresets: settings.fusionPresets,
    baseOverrides: settings.providerBaseOverrides
  };

  async function buildSystemMessages(question: string): Promise<ChatMessage[]> {
    const system: ChatMessage[] = [{ role: "system", content: effortDirective(settings.effort) }];
    if (settings.memoryEnabled) {
      try {
        const hits = await memory.recall(question, settings.memoryRecallK);
        const preamble = memoryPreamble(hits);
        if (preamble) system.push({ role: "system", content: preamble });
      } catch {
        // memória indisponível não bloqueia a conversa
      }
    }
    const channel = opsChannelForMode[mode];
    if (channel) system.push({ role: "system", content: opsInstruction(channel, opsCatalogs[channel]) });
    return system;
  }

  /**
   * Auto-compact: se o histórico passa do orçamento, resume as mensagens
   * antigas num único system e AVISA na conversa (sem pedir confirmação).
   */
  async function compactHistory(history: ChatMessage[], signal: AbortSignal): Promise<ChatMessage[]> {
    const plan = planCompaction(history, { maxTokens: 12_000, keepRecent: 8 });
    if (!plan) return history.slice(-12);
    const summary = await chatOnce(
      selection,
      mode,
      buildSummaryRequest(plan.toSummarize),
      ctx,
      { onDelta: () => undefined },
      signal
    ).catch(() => "");
    if (!summary) return history.slice(-12);
    appendMessage(mode, { role: "assistant", content: compactionNotice(plan.toSummarize.length), meta: { kind: "ops" } });
    return [{ role: "system", content: `Resumo da conversa anterior:\n${summary}` }, ...plan.keep];
  }

  async function runAssistantTurn(request: ChatMessage[], signal: AbortSignal): Promise<string> {
    appendMessage(mode, { role: "assistant", content: "" });
    // Coalescing por frame: os tokens chegam na taxa do provedor, mas a
    // repintura é 1×/frame — sem isso o React congela em respostas rápidas.
    const buffer = createStreamBuffer((chunk) => patchLastAssistant(mode, chunk));
    const reasoningBuffer = createStreamBuffer((chunk) => patchLastReasoning(mode, chunk));
    try {
      const final = await chatOnce(selection, mode, request, ctx, {
        onDelta: (delta) => buffer.push(delta),
        onReasoning: (delta) => reasoningBuffer.push(delta),
        onStage: (stage) => setStage(stage)
      }, signal);
      buffer.flush();
      reasoningBuffer.flush();
      return final;
    } catch (cause) {
      buffer.dispose();
      reasoningBuffer.dispose();
      throw cause;
    }
  }

  /** Turno agêntico: o modelo executa ferramentas (com aprovação) até concluir. */
  async function runAgentTurn(request: ChatMessage[], signal: AbortSignal): Promise<string> {
    const root = window.localStorage.getItem("code.root") ?? ".";
    toolGroupOpenRef.current = false;
    // Servidores MCP configurados entram no catálogo do agente (namespaced).
    const mcpClients = new Map<string, McpHttpClient>();
    const mcpSpecs: string[] = [];
    for (const server of settings.mcpServers) {
      try {
        const client = new McpHttpClient(server);
        const tools = await client.listTools();
        mcpClients.set(server.name, client);
        for (const spec of mcpToolsToSpecs(server.name, tools)) mcpSpecs.push(`- ${spec.name}: ${spec.description}`);
      } catch {
        // Servidor MCP fora do ar não bloqueia o turno.
      }
    }
    const instruction = mcpSpecs.length
      ? `${agentSystemInstruction()}\n\nFerramentas MCP externas (exigem aprovação):\n${mcpSpecs.join("\n")}`
      : agentSystemInstruction();
    const messages: ChatMessage[] = [{ role: "system", content: instruction }, ...request];
    return runAgentLoop(messages, {
      runTurn: async (msgs) => {
        appendMessage(mode, { role: "assistant", content: "" });
        const buffer = createStreamBuffer((chunk) => patchLastAssistant(mode, chunk));
        try {
          const raw = await chatOnce(
            selection,
            mode,
            msgs,
            ctx,
            { onDelta: (delta) => buffer.push(delta), onStage: (stage) => setStage(stage) },
            signal
          );
          buffer.flush();
          return raw;
        } catch (cause) {
          buffer.dispose();
          throw cause;
        }
      },
      signal,
      runTool: async (call) => {
        // web_search precisa do motor (planeja consultas) — resolvido aqui, onde
        // a seleção de modelo existe; devolve fontes que viram chips no cartão.
        if (call.tool === "web_search") {
          const query = String(call.args.query ?? "").trim();
          if (!query) return { ok: false, output: "web_search exige args.query" };
          try {
            const research = await import("../lib/research");
            const report = await research.runResearch(
              query,
              (msgs) => chatOnce(selection, mode, msgs, ctx, { onDelta: () => undefined }, signal),
              { onStage: (stage) => setStage(stage) }
            );
            return {
              ok: true,
              output: research.researchSystemContext(report),
              sources: report.sources.map((source) => ({ title: source.title, url: source.url, kind: source.kind }))
            };
          } catch (cause) {
            return { ok: false, output: cause instanceof Error ? cause.message : String(cause) };
          }
        }
        // Geração de imagem: usa a rota do gateway (Imagen/Flux/OpenAI Images).
        if (call.tool === "generate_image") {
          const prompt = String(call.args.prompt ?? "").trim();
          if (!prompt) return { ok: false, output: "generate_image exige args.prompt" };
          if (!session?.accessToken || !session.workspaceId) {
            return { ok: false, output: "conecte o gateway em Configurações para gerar imagens" };
          }
          try {
            const { generateImage } = await import("../lib/gateway");
            const images = await generateImage(session, prompt, signal);
            if (!images.length) return { ok: false, output: "o provedor não retornou imagem" };
            return { ok: true, output: `${images.length} imagem(ns) gerada(s)`, images };
          } catch (cause) {
            return { ok: false, output: cause instanceof Error ? cause.message : String(cause) };
          }
        }
        // Ferramenta MCP externa (mcp:<servidor>:<tool>) roteia ao cliente.
        const external = parseNamespaced(call.tool);
        if (external) {
          const client = mcpClients.get(external.server);
          if (!client) return { ok: false, output: `servidor MCP "${external.server}" indisponível` };
          return client.callTool(external.tool, call.args);
        }
        // Edição: lê o conteúdo ANTES para montar o diff exibido no cartão.
        let previousContent: string | null = null;
        if (call.tool === "fs_write") {
          previousContent = await fsRead(root, String(call.args.path ?? "")).catch(() => null);
        }
        const result = await dispatchTool(call, root);
        // Diagnostics pós-edição: após gravar código, roda o check e realimenta.
        if (call.tool === "fs_write" && result.ok) {
          const path = String(call.args.path ?? "");
          updateToolGroup(mode, (cards) =>
            applyResult(cards, "fs_write", {
              status: "ok",
              edit: buildToolEdit(path, previousContent, String(call.args.content ?? ""))
            })
          );
          const command = diagnosticCommand(path);
          if (command) {
            setStage(`Diagnóstico: ${path}`);
            const check = await dispatchTool({ tool: "terminal", args: { command } }, root);
            const report = formatDiagnostics(path, check);
            appendMessage(mode, { role: "assistant", content: report, meta: { kind: "ops" } });
            return { ok: result.ok, output: `${result.output}\n\n${report}` };
          }
        }
        return result;
      },
      requestApproval: (call) =>
        new Promise<boolean>((resolve) => {
          if (signal.aborted) return resolve(false);
          // Política da TI decide se para e pergunta ou segue direto.
          if (!requiresPrompt(call, settings.approvalPolicy ?? "ask")) return resolve(true);
          // Parar durante a aprovação resolve como recusa: sem isso a promise
          // ficaria pendurada e a aba travaria em "enviando".
          const onAbort = () => {
            setPendingApproval(null);
            resolve(false);
          };
          signal.addEventListener("abort", onAbort, { once: true });
          setPendingApproval({
            call,
            resolve: (approved) => {
              signal.removeEventListener("abort", onAbort);
              resolve(approved);
            }
          });
        }),
      onToolStart: (call) => {
        setStage(`Ferramenta: ${call.tool}`);
        // Cartão estilo Studio: agrupa as chamadas da rodada num bloco recolhível.
        if (!toolGroupOpenRef.current) {
          appendMessage(mode, { role: "assistant", content: "", meta: { kind: "tools", tools: [] } });
          toolGroupOpenRef.current = true;
        }
        updateToolGroup(mode, (cards) => [
          ...cards,
          { tool: call.tool, detail: toolDetail(call), status: "running" as const }
        ]);
      },
      onToolResult: (call, result) =>
        updateToolGroup(mode, (cards) =>
          applyResult(cards, call.tool, {
            status: result.ok ? "ok" : "error",
            output: result.output.slice(0, 1500),
            sources: result.sources,
            images: result.images
          })
        )
    });
  }

  async function send(rawText?: string, options?: ComposerSendOptions) {
    const raw = (rawText ?? input).trim();
    // Comando de barra (/review, /explain…) vira o prompt completo antes do envio.
    const text = expandCommand(raw, DEFAULT_COMMANDS) ?? raw;
    const currentAttachments = useApp.getState().attachments;
    if (!text || useApp.getState().threads[mode].sending) return;
    setError("");
    setInput("");
    if (options?.echoUser !== false) appendMessage(mode, { role: "user", content: text });
    if (currentAttachments.length) setAttachments([]);
    setSending(mode, true);
    const abort = new AbortController();
    abortRef.current = abort;
    try {
      const system = await buildSystemMessages(text);
      for (const attachment of currentAttachments) {
        // Imagem vai como conteúdo de VISÃO (image_url); texto vai como system.
        if (attachment.dataUrl && attachment.mime?.startsWith("image/")) continue;
        system.push({
          role: "system",
          content: attachment.content
            ? `Arquivo anexado pelo usuário — ${attachment.name}:\n\n${attachment.content}`
            : `O usuário anexou o arquivo "${attachment.name}" (${attachment.mime || "binário"}).`
        });
      }
      const visionParts = currentAttachments
        .filter((attachment) => attachment.dataUrl && attachment.mime?.startsWith("image/"))
        .map((attachment) => ({ type: "image_url" as const, image_url: { url: attachment.dataUrl as string } }));

      if (planMode) {
        planSourceRef.current = text;
        setStage("Elaborando plano…");
        appendMessage(mode, { role: "assistant", content: "" });
        const planText = await chatOnce(selection, mode, [...system, ...buildPlanRequest(mode, text)], ctx, {
          onDelta: () => undefined,
          onStage: (stage) => setStage(stage)
        }, abort.signal);
        const plan = parsePlan(planText);
        if (plan) {
          setActivePlan(plan);
          replaceLastAssistant(mode, {
            role: "assistant",
            content: `Plano proposto: ${plan.title} — ${plan.steps.length} passos. Revise e aprove abaixo.`,
            meta: { kind: "plan", planTitle: plan.title }
          });
        } else {
          replaceLastAssistant(mode, { role: "assistant", content: planText || "Não consegui estruturar um plano." });
        }
        return;
      }

      const request: ChatMessage[] = [...system];
      if (researchMode && mode === "chat") {
        setStage("Pesquisa profunda: coletando fontes…");
        const research = await import("../lib/research");
        // A pesquisa vira um GRUPO DE FERRAMENTA na conversa: o usuário vê as
        // etapas acontecendo em vez de encarar silêncio até a resposta.
        appendMessage(mode, {
          role: "assistant",
          content: "",
          meta: { kind: "tools", tools: [{ tool: "web_search", detail: text.slice(0, 80), status: "running" }] }
        });
        const report = await research.runResearch(
          text,
          (messages) =>
            chatOnce(selection, mode, messages, ctx, { onDelta: () => undefined }, abort.signal),
          {
            onStage: (stage) => {
              setStage(stage);
              updateToolGroup(mode, (cards) => applyResult(cards, "web_search", { status: "running", output: stage }));
            }
          }
        );
        updateToolGroup(mode, (cards) =>
          applyResult(cards, "web_search", {
            status: "ok",
            output: `${report.sources.length} fonte(s) · confiança ${Math.round(report.confidence * 100)}%`,
            sources: report.sources.map((source) => ({ title: source.title, url: source.url, kind: source.kind }))
          })
        );
        setResearchReport(report);
        request.push({ role: "system", content: research.researchSystemContext(report) });
      }

      const priorMessages = useApp.getState().threads[mode].messages;
      const fullHistory = priorMessages
        .slice(0, options?.echoUser === false ? undefined : -1)
        .map(({ role, content }) => ({ role, content }));
      const history = await compactHistory(fullHistory, abort.signal);
      // Com imagem colada/anexada, a mensagem do usuário vira multimodal.
      request.push(
        ...history,
        visionParts.length
          ? ({ role: "user", content: [{ type: "text", text }, ...visionParts] } as unknown as ChatMessage)
          : { role: "user", content: text }
      );
      const final = toolsMode
        ? await runAgentTurn(request, abort.signal)
        : await runAssistantTurn(request, abort.signal);

      const channel = opsChannelForMode[mode];
      if (channel && final) opsBus.publish(channel, final);
      if (settings.memoryEnabled && final) {
        for (const candidate of extractMemoryCandidates(final)) void memory.add(candidate).catch(() => undefined);
      }
    } catch (cause) {
      if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSending(mode, false);
      setStage("");
    }
  }

  async function executePlan(plan: ExecutionPlan) {
    setExecutingPlan(true);
    setSending(mode, true);
    const abort = new AbortController();
    abortRef.current = abort;
    try {
      const system = await buildSystemMessages(planSourceRef.current);
      const final = await runAssistantTurn(
        [...system, ...buildExecuteRequest(plan, planSourceRef.current)],
        abort.signal
      );
      const channel = opsChannelForMode[mode];
      if (channel && final) opsBus.publish(channel, final);
      setActivePlan(null);
    } catch (cause) {
      if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setExecutingPlan(false);
      setSending(mode, false);
      setStage("");
    }
  }

  return (
    <footer className={`composer-wrap ${mode === "code" ? "composer-hidden" : ""}`}>
      {error && (
        <div className="error-banner" role="alert">
          <span>{error}</span>
          <button onClick={() => setError("")} aria-label="Fechar erro">
            <X size={14} />
          </button>
        </div>
      )}
      {activePlan && (
        <PlanCard
          plan={activePlan}
          executing={executingPlan}
          onApprove={() => void executePlan(activePlan)}
          onDismiss={() => setActivePlan(null)}
        />
      )}
      {pendingApproval && (
        <div className="tool-approval glass-strong" role="alertdialog" aria-label="Aprovar ação do agente">
          <div className="tool-approval-body">
            <strong>O agente quer executar {pendingApproval.call.tool}</strong>
            <code>
              {String(pendingApproval.call.args.path ?? pendingApproval.call.args.command ?? "").slice(0, 160)}
            </code>
          </div>
          <div className="tool-approval-actions">
            <button
              className="lg-button"
              onClick={() => {
                pendingApproval.resolve(false);
                setPendingApproval(null);
              }}
            >
              Recusar
            </button>
            <button
              className="lg-button primary"
              onClick={() => {
                pendingApproval.resolve(true);
                setPendingApproval(null);
              }}
            >
              Aprovar
            </button>
          </div>
        </div>
      )}
      <div className="composer glass-strong">
        {attachments.length > 0 && (
          <div className="composer-attachments">
            {attachments.map((attachment) => (
              <span className="chip accent attach-chip" key={attachment.name}>
                {attachment.dataUrl && attachment.mime?.startsWith("image/") ? (
                  <img className="attach-thumb" src={attachment.dataUrl} alt="" />
                ) : (
                  <Paperclip size={10} />
                )}
                {attachment.name}
                <i
                  role="button"
                  aria-label={`Remover ${attachment.name}`}
                  onClick={() => setAttachments(attachments.filter((item) => item.name !== attachment.name))}
                >
                  <X size={10} />
                </i>
              </span>
            ))}
          </div>
        )}
        <textarea
          ref={textareaRef}
          value={input}
          rows={1}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
          onPaste={(event) => void handlePaste(event)}
          placeholder={modePlaceholders[mode]}
          aria-label="Mensagem"
        />
        <div className="composer-row">
          {/* Motor é definido pela TI por módulo — aqui só INFORMA qual está
              valendo; a troca vive em Configurações → Motores & Fusion. */}
          <button
            className="model-select readonly"
            onClick={() => setSettingsOpen(true)}
            title="O modelo deste módulo é definido nas Configurações (administração)"
          >
            {selection.kind === "fusion" ? <span className="fusion-dot" /> : <Sparkles size={13} />}
            {describeSelection(selection, settings.fusionPresets, settings.modelCatalog)}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".txt,.md,.json,.csv,.ts,.tsx,.js,.py,.rs,.sql,.html,.css,.yml,.yaml,.toml,.log"
            style={{ display: "none" }}
            onChange={(event) => {
              void attachFiles(event.target.files);
              event.target.value = "";
            }}
          />
          <button
            className="icon-button"
            onClick={() => fileInputRef.current?.click()}
            title="Anexar arquivos de texto como contexto"
            aria-label="Anexar arquivos"
          >
            <Paperclip size={15} />
          </button>
          <button
            className={`lg-toggle ${planMode ? "on" : ""}`}
            onClick={() => setPlanMode(!planMode)}
            title="Modo planejamento: o modelo propõe um plano e espera sua aprovação"
          >
            <i />
            <ListChecks size={12} />
            Planejar
          </button>
          <button
            className={`lg-toggle ${toolsMode ? "on" : ""}`}
            onClick={() => setToolsMode(!toolsMode)}
            title="Modo agente: o modelo lê arquivos, roda comandos e edita — com aprovação para ações que alteram o projeto"
          >
            <i />
            <Wrench size={12} />
            Ferramentas
          </button>
          {toolsMode && (
            // Somente informativo: a política é definida pela TI nas Configurações.
            <button
              className="approve-chip"
              onClick={() => setSettingsOpen(true)}
              title="Política definida nas Configurações (administração)"
            >
              <ShieldCheck size={12} />
              {policyLabel(settings.approvalPolicy ?? "ask")}
            </button>
          )}
          {mode === "chat" && (
            <button
              className={`lg-toggle ${researchMode ? "on" : ""}`}
              onClick={() => setResearchMode(!researchMode)}
              title="Pesquisa profunda: coleta e avalia fontes antes de responder"
            >
              <i />
              <Telescope size={12} />
              Pesquisa
            </button>
          )}
          {researchMode && mode === "chat" && (
            <span className="chip accent">
              <Globe2 size={11} />
              avalia sites e vídeos
            </span>
          )}
          <div className="spacer" />
          <EffortSlider />
          {thread.sending ? (
            <button className="send-button stop" onClick={() => abortRef.current?.abort()} aria-label="Parar">
              <CircleStop size={16} />
            </button>
          ) : (
            <button className="send-button" onClick={() => void send()} disabled={!input.trim()} aria-label="Enviar">
              <Send size={16} />
            </button>
          )}
        </div>
      </div>
    </footer>
  );
}
