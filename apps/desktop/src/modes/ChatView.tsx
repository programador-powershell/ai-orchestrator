/**
 * CHAT — conversa adaptativa com pesquisa profunda.
 * Sem toolbar: o balão vive no centro e o rodapé embaixo (pedido de UX).
 * Balões estilo Unsloth: usuário à direita (acento), assistente à esquerda
 * (vidro) com Markdown real, ações por mensagem e métricas medidas.
 * Histórico/busca ficam no rail dinâmico (ChatRail).
 */
import "../styles/modes/chat.css";
import { Fragment, useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { ResearchSource } from "@ai-bot/contracts";
import {
  Brain,
  Check,
  Copy,
  FileText,
  Globe2,
  History,
  MessageCircle,
  MessagesSquare,
  Pencil,
  Play,
  RefreshCw,
  Sparkles,
  Telescope
} from "lucide-react";
import { Markdown } from "../components/Markdown";
import { EmptyHero, PromptCards, Surface, VBody, VCenter, VStatus } from "../components/Primitives";
import { RailConversations } from "../components/RailConversations";
import { buildEditPayload, buildRegeneratePayload, charCount, formatDuration, wordCount } from "../lib/chatUtils";
import { describeSelection } from "../lib/engine";
import { composerBus } from "../lib/ops";
import { formatTokens, messageTokens } from "../lib/contextMeter";
import { useApp, type ThreadMessage } from "../lib/store";
import { ToolGroup } from "../components/ToolGroup";
import { ReasoningBlock } from "../components/ReasoningBlock";
import { ThinkingRow } from "../components/ThinkingRow";

const isTauriHost = "__TAURI_INTERNALS__" in window;

const suggestedPrompts = [
  "Qual o estado da arte em orquestração de múltiplos modelos de IA?",
  "Compare Tauri e Electron para aplicativos desktop em 2026",
  "Pesquise prós e contras do design liquid glass em interfaces"
];

const kindMeta: Record<ResearchSource["kind"], { label: string; icon: typeof Globe2 }> = {
  site: { label: "site", icon: Globe2 },
  video: { label: "vídeo", icon: Play },
  doc: { label: "doc", icon: FileText }
};

function sourceHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

async function openSource(url: string) {
  if (isTauriHost) {
    try {
      await openUrl(url);
      return;
    } catch {
      // plugin indisponível: cai no navegador padrão do webview
    }
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

function SourceCard({ source, index }: { source: ResearchSource; index: number }) {
  const meta = kindMeta[source.kind];
  const Icon = meta.icon;
  const pct = Math.round(Math.min(1, Math.max(0, source.credibility)) * 100);
  return (
    <button className="chatx-source" onClick={() => void openSource(source.url)} title={source.url}>
      <span className="chatx-fav" aria-hidden="true">
        {sourceHost(source.url).charAt(0).toUpperCase() || "?"}
      </span>
      <span className="chatx-source-main">
        <strong>
          [{index + 1}] {source.title}
        </strong>
        <small>
          {sourceHost(source.url)} · <Icon size={10} /> {meta.label}
        </small>
        <span className="chatx-cred" role="img" aria-label={`Credibilidade ${pct}%`}>
          <i style={{ transform: `scaleX(${pct / 100})` }} />
        </span>
        <em>{source.summary}</em>
      </span>
    </button>
  );
}

function SourcesPanel() {
  const report = useApp((state) => state.researchReport);
  if (!report) return null;
  return (
    <div className="chatx-sources">
      <header>
        <span className="eyebrow">
          <Telescope size={11} /> Fontes avaliadas
        </span>
        <span className="chip accent">confiança {Math.round(report.confidence * 100)}%</span>
      </header>
      <div className="chatx-source-grid">
        {report.sources.map((source, index) => (
          <SourceCard key={`${source.url}-${index}`} source={source} index={index} />
        ))}
      </div>
      {report.openQuestions.length > 0 && (
        <footer>
          <small>Em aberto: {report.openQuestions.join(" · ")}</small>
        </footer>
      )}
    </div>
  );
}

/** Rail dinâmico da aba Chat: busca real + conversas persistidas. */
export function ChatRail() {
  return (
    <>
      <span className="eyebrow">CONVERSAS</span>
      {/* Sem `searchable`: a busca subiu para a barra do topo e vale para
          todas as abas. Duas caixas para a mesma busca dariam dois lugares
          para procurar a mesma coisa. */}
      <RailConversations mode="chat" />
    </>
  );
}

/** Remove o par pergunta/resposta do thread e reenvia a mesma pergunta de verdade. */
function regenerateLastAnswer() {
  const state = useApp.getState();
  if (state.threads.chat.sending) return;
  const payload = buildRegeneratePayload(state.threads.chat.messages);
  if (!payload) return;
  useApp.setState((current) => ({
    threads: { ...current.threads, chat: { ...current.threads.chat, messages: payload.trimmedMessages } }
  }));
  // Echo padrão do composer: a pergunta volta ao thread UMA vez e o pedido
  // ao motor a contém UMA vez (o par foi removido acima — sem duplicação).
  composerBus.send(payload.lastUserText);
}

/** Carrega a última pergunta no composer e remove o par pergunta/resposta. */
function editLastQuestion() {
  const state = useApp.getState();
  if (state.threads.chat.sending) return;
  const payload = buildEditPayload(state.threads.chat.messages);
  if (!payload) return;
  useApp.setState((current) => ({
    threads: { ...current.threads, chat: { ...current.threads.chat, messages: payload.trimmedMessages } }
  }));
  state.setInput(payload.lastUserText);
}

export function ChatView() {
  const messages = useApp((state) => state.threads.chat.messages);
  const sending = useApp((state) => state.threads.chat.sending);
  const stage = useApp((state) => state.stage);
  const engine = useApp((state) => state.settings.engines.chat);
  const fusionPresets = useApp((state) => state.settings.fusionPresets);
  const modelCatalog = useApp((state) => state.settings.modelCatalog);
  const memoryEnabled = useApp((state) => state.settings.memoryEnabled);
  const report = useApp((state) => state.researchReport);
  const conversationCount = useApp((state) => state.conversations.chat.length);
  const activeConversationId = useApp((state) => state.activeConversation.chat);
  const scrollRef = useRef<HTMLDivElement>(null);
  /** O relatório de pesquisa só acompanha a conversa que contém a pergunta que o originou. */
  const reportInThread =
    report !== null && messages.some((message) => message.role === "user" && message.content === report.question);

  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  /** Durações MEDIDAS nesta sessão (performance.now entre início e fim do envio). */
  const [durations, setDurations] = useState<Record<string, number>>({});
  const sendStartRef = useRef<number | null>(null);
  const prevSendingRef = useRef(false);

  /**
   * Auto-scroll fluido: agenda no próximo frame (evita reflow síncrono a cada
   * token) e só arrasta se o usuário está perto do fim — quem rolou para cima
   * para ler continua lendo, como no ChatGPT/Claude.
   */
  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const distanceFromBottom = node.scrollHeight - node.scrollTop - node.clientHeight;
    if (distanceFromBottom > 120) return;
    const frame = requestAnimationFrame(() => {
      node.scrollTop = node.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [messages, sending]);

  useEffect(() => {
    if (sending && !prevSendingRef.current) {
      sendStartRef.current = performance.now();
    } else if (!sending && prevSendingRef.current && sendStartRef.current !== null) {
      const elapsed = performance.now() - sendStartRef.current;
      sendStartRef.current = null;
      const state = useApp.getState();
      const thread = state.threads.chat.messages;
      const index = thread.reduce((last, message, i) => (message.role === "assistant" ? i : last), -1);
      if (index >= 0 && thread[index].content) {
        const key = `${state.activeConversation.chat}:${index}`;
        setDurations((current) => ({ ...current, [key]: elapsed }));
      }
    }
    prevSendingRef.current = sending;
  }, [sending]);

  function copyMessage(index: number, content: string) {
    void navigator.clipboard?.writeText(content).then(() => {
      setCopiedIndex(index);
      window.setTimeout(() => setCopiedIndex((current) => (current === index ? null : current)), 1600);
    });
  }

  const lastAssistantIndex = messages.reduce(
    (last, message, index) => (message.role === "assistant" ? index : last),
    -1
  );
  const lastUserIndex = messages.reduce((last, message, index) => (message.role === "user" ? index : last), -1);

  function renderMessage(message: ThreadMessage, index: number) {
    const isAssistant = message.role === "assistant";
    const duration = durations[`${activeConversationId}:${index}`];
    const streamingThis = sending && index === messages.length - 1;
    return (
      <article className={`chatx-row ${message.role}`}>
        {isAssistant && (
          <span className="chatx-avatar" aria-hidden="true">
            <Sparkles size={13} />
          </span>
        )}
        <div className="chatx-col">
          {isAssistant && message.meta?.reasoning && (
            <ReasoningBlock text={message.meta.reasoning} active={streamingThis && !message.content} />
          )}
          {message.meta?.kind === "tools" ? (
            <ToolGroup cards={message.meta.tools ?? []} />
          ) : (
            <div className={`chatx-balloon ${message.role}`}>
              {isAssistant ? (
                message.content ? (
                  <Markdown source={message.content} />
                ) : (
                  <span className="chatx-pending">…</span>
                )
              ) : (
                <p>{message.content || "…"}</p>
              )}
            </div>
          )}
          <footer className="chatx-msg-foot">
            {isAssistant && message.content.length > 0 && (
              // Custo POR MENSAGEM: o medidor do topo mede a janela do modelo,
              // que é outra pergunta. Aqui interessa o que ESTA resposta custou.
              <span className="chatx-meta">
                {duration !== undefined && !streamingThis ? `${formatDuration(duration)} · ` : ""}
                {formatTokens(messageTokens(message))} tokens
              </span>
            )}
            {message.content.length > 0 && (
              <span className="chatx-actions">
                <button onClick={() => copyMessage(index, message.content)} title="Copiar mensagem">
                  {copiedIndex === index ? <Check size={11} /> : <Copy size={11} />}
                  {copiedIndex === index ? "copiado" : "copiar"}
                </button>
                {isAssistant && index === lastAssistantIndex && !sending && (
                  <button onClick={regenerateLastAnswer} title="Remove esta resposta e reenvia a mesma pergunta">
                    <RefreshCw size={11} />
                    regenerar
                  </button>
                )}
                {!isAssistant && index === lastUserIndex && !sending && (
                  <button onClick={editLastQuestion} title="Carrega a pergunta no composer e remove o par do thread">
                    <Pencil size={11} />
                    editar
                  </button>
                )}
              </span>
            )}
          </footer>
        </div>
      </article>
    );
  }

  return (
    <Surface className="chatx">
      <VBody>
        <VCenter>
          {messages.length === 0 ? (
            <EmptyHero
              icon={<MessageCircle size={26} />}
              kicker="CONVERSA ADAPTATIVA"
              title="O que vamos explorar?"
              detail="Converse com qualquer motor. Ative a Pesquisa no composer para coletar fontes, avaliar credibilidade e responder com citações [n]."
            >
              <PromptCards prompts={suggestedPrompts} onPrompt={(prompt) => useApp.getState().setInput(prompt)} />
            </EmptyHero>
          ) : (
            <div className="thread chatx-thread" ref={scrollRef}>
              {messages.map((message, index) => (
                <Fragment key={index}>
                  {reportInThread && index === lastAssistantIndex && <SourcesPanel />}
                  {renderMessage(message, index)}
                </Fragment>
              ))}
              {/* Progresso INLINE no fim da conversa (não popup sobreposto).
                  Some assim que o primeiro token chega — senão duplicaria com
                  a bolha do assistente que já está crescendo. */}
              {sending && !messages.at(-1)?.content && <ThinkingRow stage={stage} />}
            </div>
          )}
        </VCenter>
      </VBody>

      <VStatus>
        <span>
          <MessagesSquare size={11} /> {messages.length} mensagens
        </span>
        <span>
          <History size={11} /> {conversationCount} conversa{conversationCount === 1 ? "" : "s"}
        </span>
        <span>
          <Brain size={11} /> memória {memoryEnabled ? "ativa" : "desligada"}
        </span>
        <span className="chip accent">{describeSelection(engine, fusionPresets, modelCatalog)}</span>
        {report && reportInThread && (
          <span>
            <Telescope size={11} /> {report.sources.length} fontes · confiança {Math.round(report.confidence * 100)}%
          </span>
        )}
        <div className="spacer" />
        <span>{sending ? stage || "processando…" : "pronto"}</span>
      </VStatus>
    </Surface>
  );
}
