/**
 * Composer compartilhado — presente em TODAS as abas, com a mesma geometria.
 * Input de chat, modo planejamento, seleção de motor (workspace/local/modelo/fusion)
 * e pesquisa profunda no Chat. Injeta memória persistente em qualquer motor.
 */
import { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  CircleStop,
  Cpu,
  Globe2,
  ListChecks,
  Merge,
  Paperclip,
  Send,
  Server,
  Sparkles,
  Telescope,
  X
} from "lucide-react";
import type { EngineSelection, ExecutionPlan } from "@ai-orchestrator/contracts";
import type { ChatMessage } from "../lib/gateway";
import { chatOnce, describeSelection, fusionModels, type EngineContext } from "../lib/engine";
import { extractMemoryCandidates, memory, memoryPreamble } from "../lib/memory";
import { composerBus, opsBus, opsInstruction, type ComposerSendOptions } from "../lib/ops";
import { DEFAULT_COMMANDS, expandCommand } from "../lib/commands";
import { opsCatalogs, opsChannelForMode } from "../lib/opsCatalogs";
import { buildExecuteRequest, buildPlanRequest, parsePlan } from "../lib/planner";
import { effortDirective, useApp } from "../lib/store";
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
  const settings = useApp((state) => state.settings);
  const setEngine = useApp((state) => state.setEngine);
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
  const { appendMessage, patchLastAssistant, replaceLastAssistant, setSending } = useApp.getState();

  const [menuOpen, setMenuOpen] = useState(false);
  const [executingPlan, setExecutingPlan] = useState(false);
  const abortRef = useRef<AbortController | undefined>(undefined);
  const planSourceRef = useRef("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const selection = settings.engines[mode];

  useEffect(() => {
    textareaRef.current?.focus();
  }, [mode]);

  // Seletor de motor fecha ao clicar fora ou com Esc (não só no próprio botão).
  useEffect(() => {
    if (!menuOpen) return;
    function onPointerDown(event: PointerEvent) {
      if (menuRef.current && event.target instanceof Node && !menuRef.current.contains(event.target)) {
        setMenuOpen(false);
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setMenuOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  useEffect(
    () =>
      composerBus.register((text, options) => {
        void send(text, options);
      }),
    // send captura o estado atual via getState/closures a cada registro
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mode, planMode, researchMode, settings, session, runtimeStatus]
  );

  async function attachFiles(files: FileList | null) {
    if (!files?.length) return;
    const loaded = await Promise.all(
      [...files].slice(0, 5).map(async (file) => ({
        name: file.name,
        content: (await file.text()).slice(0, 60_000)
      }))
    );
    setAttachments([...attachments, ...loaded].slice(0, 5));
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

  async function runAssistantTurn(request: ChatMessage[], signal: AbortSignal): Promise<string> {
    appendMessage(mode, { role: "assistant", content: "" });
    const final = await chatOnce(selection, mode, request, ctx, {
      onDelta: (delta) => patchLastAssistant(mode, delta),
      onStage: (stage) => setStage(stage)
    }, signal);
    return final;
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
        system.push({
          role: "system",
          content: `Arquivo anexado pelo usuário — ${attachment.name}:\n\n${attachment.content}`
        });
      }

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
        const report = await research.runResearch(
          text,
          (messages) =>
            chatOnce(selection, mode, messages, ctx, { onDelta: () => undefined }, abort.signal),
          { onStage: (stage) => setStage(stage) }
        );
        setResearchReport(report);
        request.push({ role: "system", content: research.researchSystemContext(report) });
      }

      const priorMessages = useApp.getState().threads[mode].messages;
      const history = priorMessages
        .slice(0, options?.echoUser === false ? undefined : -1)
        .slice(-12)
        .map(({ role, content }) => ({ role, content }));
      request.push(...history, { role: "user", content: text });
      const final = await runAssistantTurn(request, abort.signal);

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

  function choose(nextSelection: EngineSelection) {
    setEngine(mode, nextSelection);
    setMenuOpen(false);
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
      <div className="composer glass-strong">
        {attachments.length > 0 && (
          <div className="composer-attachments">
            {attachments.map((attachment) => (
              <span className="chip accent" key={attachment.name}>
                <Paperclip size={10} />
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
          placeholder={modePlaceholders[mode]}
          aria-label="Mensagem"
        />
        <div className="composer-row">
          <div style={{ position: "relative" }} ref={menuRef}>
            <button className="model-select" onClick={() => setMenuOpen((open) => !open)} aria-haspopup="menu" aria-expanded={menuOpen}>
              {selection.kind === "fusion" ? <span className="fusion-dot" /> : <Sparkles size={13} />}
              {describeSelection(selection, settings.fusionPresets, settings.modelCatalog)}
              <ChevronDown size={13} />
            </button>
            {menuOpen && (
              <div className="engine-menu glass-strong" role="menu">
                <button onClick={() => choose({ kind: "workspace" })}>
                  <Server size={13} />
                  Rota do workspace
                  <small>gateway</small>
                </button>
                <button onClick={() => choose({ kind: "local" })}>
                  <Cpu size={13} />
                  Runtime local
                  <small>{runtimeStatus.running ? "ativo" : "parado"}</small>
                </button>
                {settings.modelCatalog.length > 0 && <span className="eyebrow">MODELOS</span>}
                {settings.modelCatalog.map((entry) => (
                  <button
                    key={`${entry.providerId}/${entry.model}`}
                    onClick={() => choose({ kind: "model", target: { providerId: entry.providerId, model: entry.model } })}
                  >
                    <Sparkles size={13} />
                    {entry.label ?? entry.model}
                    <small>{entry.providerId}</small>
                  </button>
                ))}
                {settings.fusionPresets.map((preset) => (
                  <button
                    key={preset.id}
                    title={`Funde: ${fusionModels(preset, settings.modelCatalog)}`}
                    onClick={() => choose({ kind: "fusion", presetId: preset.id })}
                  >
                    <Merge size={13} />
                    {preset.name}
                    <small>{fusionModels(preset, settings.modelCatalog)}</small>
                  </button>
                ))}
              </div>
            )}
          </div>
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
