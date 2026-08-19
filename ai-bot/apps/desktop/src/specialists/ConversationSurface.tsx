/**
 * Superfície de conversa — a padrão, e a que carrega a ideia do produto.
 *
 * A conversa MISTURA especialistas. Cada linha traz quem a atendeu, e a troca
 * no meio do fio é visível: entra uma faixa de "agora é <Nome>" antes da linha
 * nova, com o motivo da rota no `title`. Sem isso o app viraria um chat comum
 * onde a resposta muda de tom sem explicação.
 *
 * O mesmo componente roda em modo compacto como coluna lateral do editor e do
 * documento — duas conversas com regras de renderização diferentes seria a
 * forma mais fácil de a linha do especialista parar de aparecer em uma delas.
 *
 * As classes seguem `styles/shell.css` (.stage-scroll, .thread, .line,
 * .line-avatar, .line-body, .line-meta, .handoff*): a moldura é de lá, este
 * arquivo só decide o que entra nela.
 */

import { GrokAvatar, grokSpecialistOf } from "../avatar/GrokAvatar";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";
import { Bot, Brain, Check, ChevronRight, Copy, MessagesSquare, Pencil, RotateCcw, Wrench, X } from "lucide-react";
import { MASTER_ID } from "@aibot/contracts";
import type {
  Avatar,
  ConversationLine,
  ProtocolError,
  Route,
  RouteReason,
  SpecialistDefinition,
  ToolCall,
  ToolResult
} from "@aibot/contracts";
import { BotAvatar } from "../avatar/BotAvatar";
import { MASTER, SPECIALIST_ICON, hueStyle, specialistById } from "../lib/specialists";
import { ultimoTurnoDoUsuario, useApp } from "../lib/store";
import { createMarkdownStream, renderMarkdown, type MarkdownStream } from "../lib/markdown";
import { SurfaceStatus } from "../shell/StatusBar";

/* -------------------------------- auxiliares ------------------------------ */

/**
 * O matiz por especialista mora em `lib/specialists` — o shell também precisa
 * dele. Continua exportado daqui porque é por este caminho que as outras
 * superfícies já o importam.
 */
export { hueStyle };

/**
 * O master não está na lista de escolhíveis e `specialistById` derruba id
 * desconhecido em "chat" — sem este desvio, uma linha do master apareceria
 * como se fosse do especialista de conversa.
 */
export function resolveSpecialist(list: SpecialistDefinition[], id: string): SpecialistDefinition {
  if (id === MASTER_ID) return MASTER;
  return specialistById(list, id);
}

function avatarOf(avatars: Record<string, Avatar>, spec: SpecialistDefinition): Avatar {
  return avatars[spec.id] ?? spec.avatar;
}

/**
 * O motivo da rota, em português, para o title da faixa de troca.
 *
 * `sticky` é o caso mais comum depois do primeiro turno e NÃO significa
 * "desisti de decidir": a conversa já tem modo, e do segundo input em diante
 * nada é reclassificado. A frase precisa dizer isso, senão a pessoa lê "seguiu o
 * anterior" como preguiça do roteador.
 */
const REASON_TEXT: Record<RouteReason, string> = {
  explicit: "você escolheu",
  heuristic: "pelo texto do pedido, sem consultar modelo",
  needle: "o roteador local decidiu, nesta máquina",
  model: "o master classificou",
  sticky: "a conversa já está neste modo — use /mode para trocar",
  fallback: "sem sinal claro"
};

function confidencePercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  // O gateway manda 0..1. Se algum dia mandar 0..100, não multiplicar de novo.
  const scaled = value <= 1 ? value * 100 : value;
  return Math.max(0, Math.min(100, Math.round(scaled)));
}

function handoffTitle(route: Route): string {
  const reason = REASON_TEXT[route.reason] ?? "o master decidiu";
  const parts = [`${reason} · confiança ${confidencePercent(route.confidence)}%`];
  if (route.signals && route.signals.length > 0) parts.push(`sinais: ${route.signals.join(", ")}`);
  return parts.join(" · ");
}

function clamp(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/**
 * A duração do turno em gente: "870 ms", "12,4 s", "2min 05s". A vírgula é de
 * propósito — a UI inteira fala pt-BR, e "12.4 s" leria como milhar.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1).replace(".", ",")} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}min ${String(rest).padStart(2, "0")}s`;
}

function scalarOf(value: unknown): string {
  if (value === null) return "nulo";
  if (typeof value === "string") return clamp(value, 60);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.length}]`;
  if (typeof value === "object") return "{…}";
  return "";
}

/** Uma linha de resumo dos argumentos — nunca o JSON inteiro na tela. */
export function summarizeArgs(args: unknown): string {
  if (args === undefined || args === null) return "";
  if (typeof args === "string") return clamp(args, 120);
  if (typeof args === "number" || typeof args === "boolean") return String(args);
  if (Array.isArray(args)) return clamp(args.map((item) => scalarOf(item)).join(", "), 120);
  if (typeof args === "object") {
    const entries = Object.entries(args as Record<string, unknown>);
    return clamp(entries.map(([key, value]) => `${key}: ${scalarOf(value)}`).join("   "), 140);
  }
  return "";
}

/* ------------------------------ sub-componentes --------------------------- */

/**
 * A faixa de troca de dono.
 *
 * As linhas horizontais são `::before`/`::after` no CSS — daí não haver span
 * nenhum de decoração aqui dentro.
 */
function Handoff({ route, spec }: { route: Route; spec: SpecialistDefinition }): ReactNode {
  const Icon = SPECIALIST_ICON[spec.id] ?? Bot;
  const title = handoffTitle(route);
  return (
    <div
      className="handoff"
      style={hueStyle(spec.hue)}
      title={title}
      role="separator"
      aria-label={`agora é ${spec.name} — ${title}`}
    >
      <span className="handoff-icon">
        <Icon aria-hidden="true" />
      </span>
      agora é <span className="handoff-name">{spec.name}</span>
    </div>
  );
}

function ToolStrip({ calls, results }: { calls?: ToolCall[]; results?: ToolResult[] }): ReactNode {
  const [open, setOpen] = useState(false);

  const byId = useMemo(() => {
    const map = new Map<string, ToolResult>();
    for (const result of results ?? []) map.set(result.callId, result);
    return map;
  }, [results]);

  if (!calls || calls.length === 0) return null;

  return (
    <div className="line-tools">
      <button
        type="button"
        className="chip"
        data-active={open ? "true" : "false"}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <ChevronRight aria-hidden="true" />
        <Wrench aria-hidden="true" />
        ferramentas ({calls.length})
      </button>

      {open ? (
        <ul className="line-tools-list">
          {calls.map((call) => {
            const result = byId.get(call.callId);
            const args = summarizeArgs(call.args);
            const detail = result ? (result.ok ? result.output ?? "" : result.error ?? "") : "";
            return (
              <li className="card" key={call.callId}>
                <div className="card-head">
                  <span className="card-title">{call.tool}</span>
                  {result ? (
                    <span className="chip" data-active={result.ok ? "true" : "false"}>
                      {result.ok ? <Check aria-hidden="true" /> : <X aria-hidden="true" />}
                      {result.ok ? "ok" : "erro"}
                    </span>
                  ) : (
                    <span className="chip">em curso</span>
                  )}
                  {result && typeof result.elapsedMs === "number" ? (
                    <span className="card-eyebrow">{result.elapsedMs} ms</span>
                  ) : null}
                </div>
                {args ? <div className="card-body">{args}</div> : null}
                {detail ? <pre>{clamp(detail, 1200)}</pre> : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

function ErrorNote({ error }: { error: ProtocolError }): ReactNode {
  return (
    <p className="line-error" role="alert">
      <b>{error.code}</b> {error.message}
      {error.retryable ? " — dá para tentar de novo" : ""}
    </p>
  );
}

/**
 * O raciocínio do modelo, RECOLHIDO por padrão. Fechado porque é bastidor: quem
 * quer a resposta lê a resposta; quem quer entender COMO o modelo chegou nela
 * abre. Mesmo padrão de chip do ToolStrip — inventar um terceiro jeito de
 * recolher coisas nesta tela seria ruído.
 */
function ReasoningStrip({ text }: { text: string }): ReactNode {
  const [open, setOpen] = useState(false);
  if (text === "") return null;
  return (
    <div className="line-reasoning">
      <button
        type="button"
        className="chip"
        data-active={open ? "true" : "false"}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        title="O raciocínio que o modelo emitiu antes de responder"
      >
        <ChevronRight aria-hidden="true" />
        <Brain aria-hidden="true" />
        raciocínio
      </button>
      {open ? <pre className="line-reasoning-text">{text}</pre> : null}
    </div>
  );
}

/** Copiar UMA mensagem, com o mesmo feedback do botão do bloco de código. */
function CopyLineButton({ text }: { text: string }): ReactNode {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1400);
    return () => window.clearTimeout(timer);
  }, [copied]);

  function copy(): void {
    // Em contexto não seguro o clipboard não existe; o botão só não confirma,
    // em vez de estourar dentro do render da conversa.
    void navigator.clipboard?.writeText(text).then(
      () => setCopied(true),
      () => setCopied(false)
    );
  }

  return (
    <button
      type="button"
      className="line-action"
      onClick={copy}
      title={copied ? "copiado" : "copiar a mensagem"}
      aria-label={copied ? "copiado" : "copiar a mensagem"}
    >
      {copied ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}
      <span>{copied ? "copiado" : "copiar"}</span>
    </button>
  );
}

/**
 * O corpo em markdown de UMA linha — o caminho quente do app inteiro.
 *
 * Isolado e memoizado porque um delta re-renderiza o fio todo: sem isto, cada
 * token reparseia o markdown de TODAS as linhas da conversa, e o custo por token
 * vira o tamanho da conversa em vez do tamanho do delta. Com o `memo`, um delta
 * toca uma linha só — as outras têm `text` idêntico e nem entram no render.
 *
 * A linha que está sendo escrita usa o parse INCREMENTAL: reparsear o próprio
 * texto inteiro a cada token é O(m²) na resposta, e é esse o custo que aparece
 * numa resposta longa. Quando o `message` final chega (streaming = false), o
 * parse volta a ser o de uma vez só — é ele a fonte da verdade da árvore.
 */
const LineMarkdown = memo(function LineMarkdown({
  id,
  text,
  streaming
}: {
  id: string;
  text: string;
  streaming: boolean;
}): ReactNode {
  const held = useRef<{ id: string; parser: MarkdownStream } | null>(null);

  return useMemo(() => {
    if (!streaming) {
      // Terminou: o acumulador do stream só ocuparia memória (ele guarda uma
      // cópia do texto) por uma linha que não recebe mais nada.
      held.current = null;
      return renderMarkdown(text);
    }
    const current = held.current;
    /*
     * O stream é uma CACHE, não estado: ele só vale enquanto for o mesmo id e o
     * texto continuar sendo uma continuação do que ele já viu. Se qualquer uma
     * das duas coisas mudar (linha reciclada, texto substituído pelo `message`,
     * replay), ele é jogado fora e refeito — por isso escrever nele durante o
     * render não torna o resultado dependente da ordem: para um mesmo `text` a
     * árvore devolvida é sempre a mesma.
     */
    const usable = current !== null && current.id === id && text.startsWith(current.parser.text);
    const parser = usable && current !== null ? current.parser : createMarkdownStream();
    if (!usable) held.current = { id, parser };
    return parser.push(text.slice(parser.text.length));
  }, [id, text, streaming]);
});

/**
 * A linha inteira também é memoizada: `patchLine` troca a identidade só da linha
 * que mudou, então as demais recebem exatamente as mesmas props e o React pula a
 * subárvore inteira — inclusive a faixa de ferramentas e o retrato.
 */
const Row = memo(function Row({
  line,
  spec,
  avatar,
  podeRegenerar = false,
  podeEditar = false
}: {
  line: ConversationLine;
  spec: SpecialistDefinition;
  avatar: Avatar;
  /** Última resposta do turno mais recente, com a conversa parada: pode refazer. */
  podeRegenerar?: boolean;
  /** Última pergunta, idem: pode voltar ao composer para editar. */
  podeEditar?: boolean;
}): ReactNode {
  // As ações vêm do store DENTRO da linha (referências estáveis do zustand):
  // passá-las como closures do pai quebraria o memo em todo render do fio.
  const regenerate = useApp((state) => state.regenerateLastTurn);
  const edit = useApp((state) => state.editLastTurn);
  const isAssistant = line.role === "assistant";
  return (
    <div
      className="line"
      data-role={line.role}
      data-specialist={isAssistant ? spec.id : undefined}
      /* O cursor de streaming é `.line-body::after` no CSS; por isso o estado
         vira atributo em vez de um span aqui. */
      data-streaming={line.streaming ? "true" : undefined}
      data-error={line.error ? "true" : undefined}
      style={isAssistant ? hueStyle(spec.hue) : undefined}
    >
      {/* Linha da pessoa não tem retrato: o retrato marca quem atendeu, e do
          lado de cá não há especialista para marcar. */}
      {isAssistant ? (
        <span className="line-avatar">
          <BotAvatar avatar={avatar} size={20} />
        </span>
      ) : null}
      <div className="line-body">
        {/* O nome vem ANTES do texto de propósito: o cursor de streaming é o
            `::after` do corpo, e com o nome no fim ele piscaria embaixo da
            assinatura em vez de no fim da fala. */}
        {isAssistant ? <div className="line-who line-meta">{spec.name}</div> : null}
        {isAssistant ? <ReasoningStrip text={line.reasoning ?? ""} /> : null}
        <LineMarkdown id={line.id} text={line.text} streaming={line.streaming === true} />
        <ToolStrip calls={line.toolCalls} results={line.toolResults} />
        {line.error ? <ErrorNote error={line.error} /> : null}
        {/* O rodapé da bolha: métricas do turno + ações por mensagem. Só de
            resposta FECHADA — número parcial de resposta em curso é chute. */}
        {isAssistant && line.streaming !== true ? (
          <div className="line-foot line-meta">
            {typeof line.durationMs === "number" ? (
              <span className="line-foot-item" title="Duração do turno, do pedido ao fim da resposta">
                {formatDuration(line.durationMs)}
              </span>
            ) : null}
            {typeof line.outputTokens === "number" ? (
              <span className="line-foot-item" title="Tokens de saída informados pelo gateway">
                {line.outputTokens.toLocaleString("pt-BR")} tokens
              </span>
            ) : null}
            <CopyLineButton text={line.text} />
            {podeRegenerar ? (
              <button
                type="button"
                className="line-action"
                onClick={regenerate}
                title="Regenerar — apaga esta resposta do histórico e reenvia a mesma pergunta"
                aria-label="Regenerar a última resposta"
              >
                <RotateCcw size={12} aria-hidden />
                <span>regenerar</span>
              </button>
            ) : null}
          </div>
        ) : null}
        {!isAssistant && podeEditar ? (
          <div className="line-foot line-meta">
            <button
              type="button"
              className="line-action"
              onClick={edit}
              title="Editar — apaga este turno do histórico e devolve o texto ao campo para corrigir"
              aria-label="Editar a última pergunta"
            >
              <Pencil size={12} aria-hidden />
              <span>editar</span>
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
});

/* --------------------------------- exemplos ------------------------------- */

/**
 * Os quatro exemplos são de especialidades DIFERENTES de propósito: é a
 * primeira tela, e ela precisa deixar óbvio que um campo só despacha para gente
 * diferente conforme o pedido.
 */
const EXAMPLES: { specialist: string; text: string }[] = [
  { specialist: "code", text: "Leia o serviço de autenticação e proponha uma refatoração com o diff." },
  { specialist: "office", text: "Abra o contrato.docx e troque contratante por cliente no texto inteiro." },
  { specialist: "data", text: "Modele o esquema de cobrança e desenhe o ERD das tabelas." },
  { specialist: "design", text: "Monte a paleta e os estados do botão primário nos temas claro e escuro." }
];

function Hero({ compact }: { compact: boolean }): ReactNode {
  const specialists = useApp((state) => state.specialists);
  const avatars = useApp((state) => state.avatars);
  const setInput = useApp((state) => state.setInput);
  const activeSpecialist = useApp((state) => state.activeSpecialist);

  const masterAvatar = avatars[MASTER.id] ?? MASTER.avatar;

  // De QUEM é esta conversa. Numa conversa que já tem dono (a de um bot, ou a
  // que já foi roteada) o herói é ELE — a conversa com um bot "é" aquele bot,
  // visivelmente. Só a conversa recém-nascida, sem dono, mostra o master. O id
  // passa por grokSpecialistOf porque office/work/master não estão na união do
  // slime — o mapa aproxima pelo ofício.
  const dono = activeSpecialist !== "" && activeSpecialist !== MASTER_ID
    ? specialistById(specialists, activeSpecialist)
    : null;
  const heroiEspecialista = grokSpecialistOf(dono?.id ?? "chat");
  const heroiNome = dono?.name ?? MASTER.name;
  const heroiHue = dono?.hue ?? MASTER.hue;
  const heroiTitulo = dono
    ? `Esta conversa é com ${dono.name} — ${dono.tagline}.`
    : "Escreva o que você quer fazer. Eu escolho o especialista.";
  const heroiSub = dono
    ? "O que você escrever aqui vai direto para ele."
    : "Um campo de texto só — o master lê o pedido e chama quem atende.";

  if (compact) {
    // Na coluna estreita o herói roubaria o palco do editor/documento; fica a
    // frase, que é o que orienta.
    return (
      <div className="hero hero-compact" style={hueStyle(heroiHue)}>
        <BotAvatar avatar={masterAvatar} size={28} />
        <p className="hero-sub">{heroiTitulo}</p>
      </div>
    );
  }

  return (
    <div className="hero" style={hueStyle(heroiHue)}>
      {/*
        O BOT fica AQUI, no centro, e não na barra lateral.
        É a tela de "escreva o que você quer" — o bot é o assunto dela, não um
        enfeite de canto. O retrato usado é o slime, que se move; o procedural do
        laboratório (olhos em X girando) continua servindo à personalização e às
        listas, onde ele precisa ser desenhável em qualquer tamanho.
      */}
      <div className="hero-avatar">
        <GrokAvatar specialist={heroiEspecialista} state="active" size={148} title={heroiNome} />
      </div>
      <h1 className="hero-title">{heroiTitulo}</h1>
      <p className="hero-sub">{heroiSub}</p>
      <div className="grid-2 hero-examples">
        {EXAMPLES.map((example) => {
          const spec = resolveSpecialist(specialists, example.specialist);
          const Icon = SPECIALIST_ICON[spec.id] ?? Bot;
          return (
            <button
              type="button"
              className="card hero-example"
              key={example.specialist}
              style={hueStyle(spec.hue)}
              onClick={() => setInput(example.text)}
              title={`este pedido cai no especialista ${spec.name}`}
            >
              <span className="card-eyebrow">
                <Icon aria-hidden="true" /> {spec.name}
              </span>
              <span className="card-body">{example.text}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* -------------------------------- superfície ------------------------------ */

export interface ConversationSurfaceProps {
  /** Modo coluna, para conviver com o editor e com o documento. */
  compact?: boolean;
}

export function ConversationSurface({ compact = false }: ConversationSurfaceProps): ReactNode {
  const lines = useApp((state) => state.lines);
  const specialists = useApp((state) => state.specialists);
  const avatars = useApp((state) => state.avatars);
  const activeSpecialist = useApp((state) => state.activeSpecialist);
  const busy = useApp((state) => state.busy);
  const status = useApp((state) => state.status);

  const scroller = useRef<HTMLDivElement | null>(null);
  /**
   * Só rola sozinho quem já estava no fim. Subir a conversa para reler algo e
   * ser jogado de volta para baixo a cada delta é o defeito clássico de chat
   * com streaming.
   */
  const stick = useRef(true);

  const handleScroll = useCallback(() => {
    const element = scroller.current;
    if (!element) return;
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    stick.current = distance < 120;
  }, []);

  const items = useMemo(() => {
    /*
     * O regenerar/editar só existe para o ÚLTIMO turno, com a conversa parada:
     * o corte no gateway é a partir da última pergunta, então oferecer o botão
     * numa resposta antiga prometeria apagar só ela — e apagaria tudo dali para
     * baixo. `ultimaResposta` é a última linha de assistente daquele turno, que
     * é onde o botão de refazer mora.
     */
    const ultimo = !busy && status === "ready" ? ultimoTurnoDoUsuario(lines) : null;
    let ultimaResposta = "";
    if (ultimo) {
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index];
        if (line && line.role === "assistant" && line.turn === ultimo.turn) {
          ultimaResposta = line.id;
          break;
        }
      }
    }

    let previous = "";
    return lines.map((line) => {
      const id = line.specialist ?? "";
      // Compara com o último especialista VISTO, não com a linha imediatamente
      // anterior: linha de usuário não carrega especialista e faria a faixa
      // reaparecer a cada pergunta.
      const changed = Boolean(line.route) && id !== "" && id !== previous;
      const handoff = changed && line.route ? { route: line.route, spec: resolveSpecialist(specialists, id) } : null;
      if (id !== "") previous = id;
      return {
        line,
        handoff,
        podeRegenerar: ultimaResposta !== "" && line.id === ultimaResposta,
        podeEditar: ultimo !== null && line.id === ultimo.lineId
      };
    });
  }, [lines, specialists, busy, status]);

  const tail = lines.length > 0 ? lines[lines.length - 1] : undefined;
  const tailLength = tail ? tail.text.length : 0;

  useEffect(() => {
    const element = scroller.current;
    if (!element || !stick.current) return;
    // behavior instant DE PROPÓSITO: o .stage-scroll tem scroll-behavior:
    // smooth no CSS (para os saltos de âncora dos achados), e a atribuição
    // simples herdava a suavidade — cada delta do streaming REINICIAVA uma
    // animação de rolagem, mantendo o compositor ocupado durante a resposta
    // inteira. O salto seco por delta é invisível (a distância é de pixels).
    element.scrollTo({ top: element.scrollHeight, behavior: "instant" });
    // O tamanho da última linha entra nas dependências para o streaming
    // continuar rolando: o array não troca de identidade a cada delta.
  }, [lines.length, tailLength]);

  return (
    <>
      {/*
        O rodapé do app recebe o status desta superfície por portal.
        Só no modo cheio: em modo coluna quem manda no rodapé é a superfície
        hospedeira (editor, documento, canvas, quadro), e dois portais no mesmo
        slot escreveriam um por cima do outro.

        Nada de contagem inventada — o especialista só aparece DEPOIS de o
        master rotear; antes disso não há especialista, e escrever "Conversa"
        prometeria um atendimento que ainda não começou.
      */}
      {compact ? null : (
        <SurfaceStatus>
          <span className="statusbar-item">
            <MessagesSquare aria-hidden />
            <b>{lines.length}</b> {lines.length === 1 ? "linha" : "linhas"}
          </span>
          {activeSpecialist === "" ? null : (
            <span className="statusbar-item">
              atendendo: <b>{resolveSpecialist(specialists, activeSpecialist).name}</b>
            </span>
          )}
        </SurfaceStatus>
      )}

      <div
        className={compact ? "stage-scroll conversation-column" : "stage-scroll"}
        ref={scroller}
        onScroll={handleScroll}
      >
        <div className="thread">
          {items.length === 0 ? (
            <Hero compact={compact} />
          ) : (
            items.map(({ line, handoff, podeRegenerar, podeEditar }) => {
              const spec = resolveSpecialist(specialists, line.specialist ?? "");
              return (
                <div className="line-group" key={line.id}>
                  {handoff ? <Handoff route={handoff.route} spec={handoff.spec} /> : null}
                  <Row
                    line={line}
                    spec={spec}
                    avatar={avatarOf(avatars, spec)}
                    podeRegenerar={podeRegenerar}
                    podeEditar={podeEditar}
                  />
                </div>
              );
            })
          )}
        </div>
      </div>
    </>
  );
}

export default ConversationSurface;
