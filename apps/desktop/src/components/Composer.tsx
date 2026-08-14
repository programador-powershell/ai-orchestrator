/**
 * Composer compartilhado — presente em TODAS as abas, com a mesma geometria.
 * Input de chat, modo planejamento, seleção de motor (workspace/local/modelo/fusion)
 * e pesquisa profunda no Chat. Injeta memória persistente em qualquer motor.
 */
import { useEffect, useRef, useState, type ClipboardEvent } from "react";
import {
  CircleStop,
  ListChecks,
  FileCode2,
  Paperclip,
  Send,
  Sparkles,
  Telescope,
  X
} from "lucide-react";
import type { EngineSelection, ExecutionPlan } from "@ai-orchestrator/contracts";
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
import { requiresPrompt } from "../lib/approval";
import { clampEffort, effectiveAgentTools, effectiveApproval, promptMasterMessages } from "../lib/policy";
import { DESIGN_SYSTEM_KEY, designContract, emptySystem, parseSystem } from "../lib/designSystem";
import { collectFiles, fsRead } from "../lib/fsx";
import { applyMention, detectMention, extractMentionedPaths, mentionContext, rankMentions } from "../lib/mentions";
import { loadProjectRules, rulesSystemMessage } from "../lib/projectRules";
import { officeContextMessage } from "../lib/office/session";
import { shipContextMessage } from "../lib/ship/session";
import { filesFromClipboard } from "../lib/paste";
import { fileToDataUrl, toAttachmentDataUrl } from "../lib/imageAttach";
import { buildSummaryRequest, compactionNotice, planCompaction } from "../lib/compact";
import { createStreamBuffer } from "../lib/streamBuffer";
import { diagnosticCommand, formatDiagnostics } from "../lib/diagnostics";
import { McpHttpClient, mcpToolsToSpecs, parseNamespaced } from "../lib/mcp";
import { extractMemoryCandidates, memory, memoryPreamble } from "../lib/memory";
import { vectorScores } from "../lib/memoryVectors";
import { embedTexts } from "../lib/gateway";
import { assembleContext, type Injection } from "../lib/contextAssembly";
import { pluginPrompt } from "../lib/plugins";
import { usePlugins } from "../lib/pluginStore";
import { useTrajectory } from "../lib/trajectoryStore";
import { composerBus, goalBus, opsBus, opsInstruction, type ComposerSendOptions } from "../lib/ops";
import { MODE_PLACEHOLDERS, composerHidden } from "../lib/composerModes";
import { DEFAULT_COMMANDS, expandCommand } from "../lib/commands";
import { opsCatalogs, opsChannelForMode } from "../lib/opsCatalogs";
import { buildExecuteRequest, buildPlanRequest, parsePlan } from "../lib/planner";
import { effortDirective, useApp, type Attachment } from "../lib/store";
import { ApprovalSelect } from "./ApprovalSelect";
import { EffortSlider } from "./EffortSlider";
import { PlanCard } from "./PlanCard";


export function Composer() {
  const mode = useApp((state) => state.mode);
  const input = useApp((state) => state.input);
  const setInput = useApp((state) => state.setInput);
  const planMode = useApp((state) => state.planMode);
  const setPlanMode = useApp((state) => state.setPlanMode);
  const researchMode = useApp((state) => state.researchMode);
  const setResearchMode = useApp((state) => state.setResearchMode);
  const policy = useApp((state) => state.policy);
  // Plugins e trilha: o registro já vem montado (global → usuário) e o modo do
  // harness decide o que da coleta entra no prompt.
  const registry = usePlugins((state) => state.registry);
  const harnessMode = useTrajectory((state) => state.harnessMode);
  const startTrajectory = useTrajectory((state) => state.begin);
  const publishTrajectory = useTrajectory((state) => state.publish);
  const userPluginsAllowed = policy?.userPluginsAllowed ?? false;
  const setSettingsOpen = useApp((state) => state.setSettingsOpen);
  const settings = useApp((state) => state.settings);
  const updateSettings = useApp((state) => state.updateSettings);
  // Loop agentico: com politica do servidor presente, ELA decide; sem, vale a
  // configuracao local da TI (Configuracoes -> Ship).
  const toolsMode = effectiveAgentTools(policy, settings.agentTools);
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
  /** @-mentions: arquivos do projeto indexados sob demanda + sugestões abertas. */
  const [projectFiles, setProjectFiles] = useState<string[]>([]);
  const [mention, setMention] = useState<{ term: string; start: number } | null>(null);
  const [pendingApproval, setPendingApproval] = useState<{ call: ToolCall; resolve: (ok: boolean) => void } | null>(null);
  const abortRef = useRef<AbortController | undefined>(undefined);
  /**
   * Resumo da compactação, por conversa. `ate` é quantas mensagens do começo
   * ele já cobre — é o que permite resumir só o trecho novo na próxima volta.
   */
  const compactRef = useRef<{ ate: number; resumo: string } | null>(null);
  const conversaAtiva = useApp((state) => state.activeConversation[state.mode]);
  // Conversa nova ou outra conversa: o resumo anterior não fala dela.
  useEffect(() => {
    compactRef.current = null;
  }, [conversaAtiva, mode]);
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

  /**
   * Monta o contexto do pedido.
   *
   * As fontes são COLETADAS aqui e montadas num lugar só (`assembleContext`),
   * que aplica o modo do harness e registra cada injeção na trilha. Antes elas
   * eram empurradas direto no array e nada ficava registrado: quando a resposta
   * saía errada, não havia como saber qual das oito causou.
   *
   * O prompt master passa PELA coleta, como fonte inegociável: nenhum modo o
   * remove (o `assembleContext` garante isso), e assim ele aparece na trilha.
   * Ficar de fora fazia a auditoria "contexto por fonte" omitir justamente a
   * maior injeção — a trilha respondia errado a pergunta que ela existe para
   * responder ("o que está ocupando o prompt?").
   */
  async function buildSystemMessages(question: string): Promise<ChatMessage[]> {
    // A diretiva de esforço é uma linha, não uma fonte de contexto: fica fora
    // da coleta porque contá-la como injeção só sujaria o relatório.
    const system: ChatMessage[] = [
      { role: "system", content: effortDirective(clampEffort(settings.effort, policy)) }
    ];
    const candidatos: Injection[] = [];
    // Prompt master do SERVIDOR primeiro; o local complementa se permitido.
    for (const mensagem of promptMasterMessages(policy, settings.localPrompt ?? "")) {
      candidatos.push({ source: "prompt-master", content: mensagem.content });
    }
    // Contrato de marca na aba Design. Sem ele em CADA pedido, o modelo
    // respeita a identidade no primeiro prompt e a esquece no terceiro,
    // quando o contexto encheu — mesma razão do prompt master.
    if (mode === "design") {
      const contrato = designContract(parseSystem(window.localStorage.getItem(DESIGN_SYSTEM_KEY)) ?? emptySystem());
      if (contrato) candidatos.push({ source: "design-contract", content: contrato });
    }
    if (settings.memoryEnabled) {
      try {
        // Busca semântica: com gateway, os vetores aproximam por SENTIDO —
        // "como coloco no ar" acha "procedimento de deploy". Sem gateway (ou
        // sem provedor de embeddings) `vectors` fica nulo e a recuperação cai
        // na camada morfológica, que não depende de rede.
        let vectors: Map<string, number> | null = null;
        if (session) {
          const itens = await memory.listForVectors();
          vectors = await vectorScores({
            items: itens,
            query: question,
            storage: window.localStorage,
            // Gateway + workspace definem de qual espaço vetorial o cache é.
            space: `${session.baseUrl}|${session.workspaceId}`,
            embed: (inputs) => embedTexts(session, inputs)
          });
        }
        const hits = await memory.recall(question, settings.memoryRecallK, vectors ?? undefined);
        const preamble = memoryPreamble(hits);
        if (preamble) candidatos.push({ source: "memory", content: preamble });
      } catch {
        // memória indisponível não bloqueia a conversa
      }
    }
    const channel = opsChannelForMode[mode];
    if (channel) candidatos.push({ source: "ops-catalog", content: opsInstruction(channel, opsCatalogs[channel]) });
    // Office: o chat sabe QUAL arquivo está aberto, a estrutura e a seleção —
    // "aumente essa tabela em 10%" deixa de ser pergunta abstrata.
    if (mode === "office") {
      const officeContext = officeContextMessage();
      if (officeContext) candidatos.push({ source: "office-context", content: officeContext });
    }
    // Code/Agent: stack detectada e resultado do último build. Sem isso o
    // modelo sugere `npm run build` num projeto Go.
    if (mode === "code" || mode === "agent") {
      const shipContext = shipContextMessage();
      if (shipContext) candidatos.push({ source: "ship-context", content: shipContext });
    }
    // Plugins ativos — globais do admin primeiro, depois os do usuário.
    const doPlugin = pluginPrompt(registry, { mode, userPluginsAllowed });
    if (doPlugin) candidatos.push({ source: "plugins", content: doPlugin });
    // Regras do projeto (AGENTS.md, CLAUDE.md, .cursorrules) — entram por
    // ÚLTIMO de propósito: a convenção do repositório manda sobre as
    // preferências gerais quando as duas dizem coisas diferentes.
    const rulesRoot = window.localStorage.getItem("code.root") ?? ".";
    const rules = await loadProjectRules(rulesRoot, fsRead).catch(() => null);
    if (rules) candidatos.push({ source: "project-rules", content: rulesSystemMessage(rules).content });

    /**
     * @-mentions entram como FONTE, não empurradas no array depois.
     *
     * Fora da coleta, elas escapavam do modo mínimo — que a UI descreve como
     * "só a política da empresa e a sua mensagem" enquanto o arquivo inteiro
     * ia junto — e nunca apareciam na trilha, apesar de serem a maior injeção
     * do pedido.
     */
    const mencionados = extractMentionedPaths(question);
    if (mencionados.length) {
      const raiz = window.localStorage.getItem("code.root") ?? ".";
      const lidos = await Promise.all(
        mencionados.slice(0, 5).map(async (path) => ({
          path,
          content: await fsRead(raiz, path).catch(() => "")
        }))
      );
      const comConteudo = lidos.filter((file) => file.content);
      if (comConteudo.length) {
        candidatos.push({ source: "mentions", content: mentionContext(comConteudo) });
      }
    }

    const montado = assembleContext(candidatos, {
      mode: harnessMode,
      trajectory: startTrajectory(mode),
      now: Date.now()
    });
    publishTrajectory(montado.trajectory, montado.skipped);
    return [...system, ...montado.messages];
  }

  /**
   * Auto-compact: se o histórico passa do orçamento, resume as mensagens
   * antigas num único system e AVISA na conversa (sem pedir confirmação).
   */
  async function compactHistory(history: ChatMessage[], signal: AbortSignal): Promise<ChatMessage[]> {
    const plan = planCompaction(history, { maxTokens: 12_000, keepRecent: 8 });
    if (!plan) return history.slice(-12);

    /**
     * O resumo é GUARDADO entre os envios.
     *
     * Sem cache, toda mensagem enviada depois de cruzar o orçamento pagava um
     * resumo completo do histórico (uma chamada de modelo inteira, sobre um
     * texto que só cresce) e ainda acrescentava um aviso "🗜️ Contexto
     * compactado" novo ao thread — avisos que entravam no próprio histórico a
     * resumir. Uma conversa longa acumulava dezenas deles.
     *
     * Agora só o TRECHO NOVO é resumido, em cima do resumo anterior, e o aviso
     * aparece apenas quando houve compactação de verdade.
     */
    const cache = compactRef.current;
    const jaResumidas = cache ? cache.ate : 0;
    const novas = plan.toSummarize.slice(jaResumidas);
    if (cache && novas.length === 0) {
      return [{ role: "system", content: `Resumo da conversa anterior:\n${cache.resumo}` }, ...plan.keep];
    }
    const paraResumir: ChatMessage[] = cache
      ? [{ role: "system", content: `Resumo até aqui:\n${cache.resumo}` }, ...novas]
      : plan.toSummarize;
    const summary = await chatOnce(
      selection,
      mode,
      buildSummaryRequest(paraResumir),
      ctx,
      { onDelta: () => undefined },
      signal
    ).catch(() => "");
    if (!summary) {
      return cache
        ? [{ role: "system", content: `Resumo da conversa anterior:\n${cache.resumo}` }, ...plan.keep]
        : history.slice(-12);
    }
    compactRef.current = { ate: plan.toSummarize.length, resumo: summary };
    appendMessage(mode, { role: "assistant", content: compactionNotice(novas.length), meta: { kind: "ops" } });
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
        onStage: (stage) => setStage(stage),
        // Plano do orquestrador vira cartão: complexidade + executores listados.
        onFusionPlan: (plan) => {
          appendMessage(mode, {
            role: "assistant",
            content: "",
            meta: {
              kind: "tools",
              tools: plan.executors.map((executor) => ({
                tool: "fusion_executor",
                detail: `${executor.role} · ${executor.model} — ${executor.focus}`,
                status: "running" as const
              }))
            }
          });
          setStage(`Fusion · complexidade ${Math.round(plan.complexity * 100)}% · ${plan.executors.length} executor(es)`);
        },
        onFusionExecutor: (role, status) =>
          updateToolGroup(mode, (cards) =>
            cards.map((card) =>
              card.tool === "fusion_executor" && card.detail.startsWith(role) ? { ...card, status } : card
            )
          )
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
    /**
     * O fusion reescreve as mensagens de sistema nos seus builders, então a
     * instrução de ferramentas se perdia e o modo agente ficava INERTE em
     * silêncio. No modo Ferramentas, o loop fala direto com o orquestrador do
     * preset — quem coordena as ferramentas é o loop, não o fusion.
     */
    const agentSelection: EngineSelection =
      selection.kind === "fusion"
        ? (() => {
            const preset = settings.fusionPresets.find((item) => item.id === selection.presetId);
            return preset ? { kind: "model", target: preset.orchestrator } : selection;
          })()
        : selection;
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
            agentSelection,
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
              (msgs) => chatOnce(agentSelection, mode, msgs, ctx, { onDelta: () => undefined }, signal),
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
          if (!requiresPrompt(call, effectiveApproval(useApp.getState().policy, useApp.getState().settings.approvalPolicy))) return resolve(true);
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
    // A aba Agent trata o envio como OBJETIVO da equipe, não como pergunta de
    // chat: quem responde é a equipe escalada pelo orquestrador. A mensagem
    // aparece no thread do mesmo jeito, para a conversa não ficar com buraco.
    if (options?.echoUser !== false) appendMessage(mode, { role: "user", content: text });
    // Limpa ANTES do desvio: nas abas que assumem o envio (Agent, Fluxo) o
    // `deliver` retorna aqui mesmo, e o anexo ficava preso no balão — para
    // reaparecer, sem que ninguém pedisse, no próximo envio de outro assunto.
    if (currentAttachments.length) setAttachments([]);
    if (goalBus.deliver(mode, text)) return;
    setSending(mode, true);
    const abort = new AbortController();
    abortRef.current = abort;
    try {
      // As @-mentions entram pelo assembleContext (dentro daqui), junto com as
      // outras fontes — assim o modo mínimo as corta e a trilha as registra.
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

      /**
       * O histórico é o que veio ANTES do eco desta pergunta.
       *
       * O `slice(0, -1)` assumia que a última mensagem era o eco do usuário —
       * mas na pesquisa profunda o cartão de ferramentas entra DEPOIS dele.
       * O corte tirava o cartão e deixava o eco, então a pergunta ia duas
       * vezes ao modelo (o eco e o `request.push` abaixo). Cortar pelo índice
       * do eco resolve nos dois casos.
       */
      const priorMessages = useApp.getState().threads[mode].messages;
      const ecoIndex =
        options?.echoUser === false
          ? priorMessages.length
          : priorMessages.map((item) => item.role).lastIndexOf("user");
      const fullHistory = priorMessages
        .slice(0, ecoIndex < 0 ? priorMessages.length : ecoIndex)
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
    // Mesma guarda do send(). O cartão de plano continua no rodapé mesmo com
    // outro envio em curso: sem isto, aprovar o plano durante um streaming
    // punha DOIS turnos escrevendo na mesma mensagem (tokens intercalados),
    // trocava o abortRef — o botão Parar só alcançava o segundo — e o finally
    // do primeiro liberava `sending` com o segundo ainda transmitindo.
    if (useApp.getState().threads[mode].sending) return;
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
    <footer className={`composer-wrap ${composerHidden(mode) ? "composer-hidden" : ""}`}>
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
          executing={executingPlan || thread.sending}
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
      {mention && rankMentions(projectFiles, mention.term).length > 0 && (
        <div className="mention-list glass-strong" role="listbox" aria-label="Arquivos do projeto">
          {rankMentions(projectFiles, mention.term).map((path) => (
            <button
              key={path}
              className="mention-item"
              role="option"
              onClick={() => {
                const applied = applyMention(input, mention, path);
                setInput(applied.text);
                setMention(null);
                textareaRef.current?.focus();
              }}
            >
              <FileCode2 size={12} />
              <span className="mention-name">{path.split("/").pop()}</span>
              <small>{path}</small>
            </button>
          ))}
        </div>
      )}
      <div className="composer glass-strong">
        {attachments.length > 0 && (
          <div className="composer-attachments">
            {/* Identidade pelo ÍNDICE, não pelo nome: dois arquivos homônimos
                de pastas diferentes (ou duas imagens coladas, que reiniciam a
                numeração por evento) davam chave duplicada no React e o X de
                um chip descartava os dois anexos de uma vez. */}
            {attachments.map((attachment, indice) => (
              <span className="chip accent attach-chip" key={`${indice}-${attachment.name}`}>
                {attachment.dataUrl && attachment.mime?.startsWith("image/") ? (
                  <img className="attach-thumb" src={attachment.dataUrl} alt="" />
                ) : (
                  <Paperclip size={10} />
                )}
                {attachment.name}
                <i
                  role="button"
                  aria-label={`Remover ${attachment.name}`}
                  onClick={() => setAttachments(attachments.filter((_, posicao) => posicao !== indice))}
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
          onChange={(event) => {
            setInput(event.target.value);
            const found = detectMention(event.target.value, event.target.selectionStart ?? 0);
            setMention(found);
            // Indexa os arquivos do projeto na primeira menção da sessão.
            if (found && !projectFiles.length) {
              const root = window.localStorage.getItem("code.root") ?? ".";
              void collectFiles(root, { maxEntries: 400 })
                .then((entries) => setProjectFiles(entries.map((entry) => entry.path)))
                .catch(() => undefined);
            }
          }}
          onKeyDown={(event) => {
            // Esc fecha a lista de menções sem enviar.
            if (event.key === "Escape" && mention) {
              event.preventDefault();
              setMention(null);
              return;
            }
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
          onPaste={(event) => void handlePaste(event)}
          placeholder={MODE_PLACEHOLDERS[mode]}
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
          {/* O toggle "Ferramentas" saiu do composer: quem decide se o módulo
              roda o loop agêntico é a TI, em Configurações → Ship. Aqui fica só
              o controle que o usuário de fato precisa durante a conversa. */}
          {toolsMode && (
            <ApprovalSelect
              policy={effectiveApproval(policy, settings.approvalPolicy)}
              onChange={(approvalPolicy) => updateSettings({ approvalPolicy })}
              disabled={thread.sending || Boolean(policy)}
            />
          )}
          {mode === "chat" && (
            <button
              className={`lg-toggle ${researchMode ? "on" : ""}`}
              onClick={() => setResearchMode(!researchMode)}
              title="Pesquisa profunda: coleta e avalia fontes, sites e vídeos antes de responder"
            >
              <i />
              <Telescope size={12} />
              Pesquisa
            </button>
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
