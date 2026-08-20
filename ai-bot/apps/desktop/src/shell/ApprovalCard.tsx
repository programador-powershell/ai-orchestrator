/**
 * O cartão de aprovação.
 *
 * É o único lugar do app onde a pessoa autoriza uma ferramenta a agir na máquina
 * dela. Duas decisões de produto vivem aqui:
 *
 * 1. O pedido EXPIRA, e isso é visível. Um pedido de execução pendente há uma
 *    hora numa janela minimizada é um pedido que ninguém leu — aprovar depois é
 *    aprovar às cegas. O contador conta os dez minutos na cara da pessoa.
 * 2. Expirar é RECUSAR de fato, não só escrever "expirou": quando o contador
 *    zera, a recusa vai para o gateway. A interface não promete o que não faz.
 *
 * A ENTREGA (`workspace.promote`) usa o MESMO funil com corpo próprio. Com o
 * sandbox valendo por padrão no turno de trabalho, os gestos dentro da jaula
 * não pedem mais permissão um a um — a aprovação única virou esta: promover o
 * staging ao projeto. O cartão então precisa responder outra pergunta ("o que
 * vai parar no MEU projeto?"), e por isso mostra contagens e a lista de
 * caminhos em vez do nome cru da ferramenta. Recusar descarta o rascunho — e a
 * expiração de dez minutos recusa também: silêncio nunca é consentimento.
 */
import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, Clock, PackageCheck, ShieldCheck, X } from "lucide-react";
import type { ApprovalRequest, Risk } from "@aibot/contracts";
import { ehEntrega, parseEntrega, type Entrega } from "../lib/entrega";
import { useApp } from "../lib/store";

/** Dez minutos, o mesmo prazo que o gateway usa para descartar o pedido. */
const APPROVAL_TTL_MS = 10 * 60 * 1000;

const RISK_LABEL: Record<Risk, string> = {
  read: "leitura",
  write: "escrita",
  execute: "execução",
  network: "rede",
  secret: "segredo"
};

const RISK_HINT: Record<Risk, string> = {
  read: "Lê arquivos da sua máquina.",
  write: "Altera arquivos da sua máquina.",
  execute: "Roda um comando na sua máquina.",
  network: "Fala com a rede, fora daqui.",
  secret: "Toca em credenciais."
};

function clock(ms: number) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = String(Math.floor(total / 60)).padStart(2, "0");
  const seconds = String(total % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

/** "2 criados · 1 alterado · 1 apagado" — só o que existe entra na frase. */
function contagensDaEntrega(entrega: Entrega): string {
  const partes: string[] = [];
  if (entrega.criados > 0) partes.push(`${entrega.criados} criado${entrega.criados === 1 ? "" : "s"}`);
  if (entrega.alterados > 0) {
    partes.push(`${entrega.alterados} alterado${entrega.alterados === 1 ? "" : "s"}`);
  }
  if (entrega.apagados > 0) partes.push(`${entrega.apagados} apagado${entrega.apagados === 1 ? "" : "s"}`);
  return partes.join(" · ");
}

/** A marca visual de cada tipo; a PALAVRA vai no title — cor nunca é a única prova. */
const MARCA_DA_MUDANCA: Record<string, string> = {
  criado: "+",
  alterado: "~",
  apagado: "−"
};

/**
 * O corpo específico da entrega: contagens + a lista de caminhos, ABERTA.
 *
 * Aberta como o plano do AskCard, e pela mesma lição: a lista É o objeto da
 * decisão — escondê-la atrás de um <details> fechado pediria um "permitir"
 * no escuro. Ela rola sozinha (CSS) para cinquenta arquivos não empurrarem os
 * botões para fora da tela.
 */
function CorpoDaEntrega({ entrega }: { entrega: Entrega }) {
  if (entrega.mudancas.length === 0) return null;
  const contagens = contagensDaEntrega(entrega);
  return (
    <div className="approval-entrega">
      {contagens !== "" ? (
        <p className="approval-entrega-contagens">{contagens}</p>
      ) : null}
      <ul className="approval-entrega-lista">
        {entrega.mudancas.map((mudanca) => (
          <li key={`${mudanca.tipo ?? "?"}:${mudanca.caminho}`} data-tipo={mudanca.tipo}>
            <span className="approval-entrega-marca" title={mudanca.tipo ?? "mudança"} aria-hidden>
              {MARCA_DA_MUDANCA[mudanca.tipo ?? ""] ?? "·"}
            </span>
            <code>{mudanca.caminho}</code>
            {/* O tipo por extenso para leitor de tela — a marca acima é decoração. */}
            <span className="visually-hidden">{mudanca.tipo ?? ""}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ApprovalCard() {
  // A CABEÇA da fila. Os outros pedidos continuam vivos atrás dela — antes o
  // segundo sobrescrevia o primeiro e os invisíveis morriam no relógio,
  // segurando a onda da equipe inteira.
  const queue = useApp((state) => state.pendingApprovals);
  const request = queue[0] ?? null;
  const waiting = Math.max(0, queue.length - 1);
  const decide = useApp((state) => state.decide);

  const [remaining, setRemaining] = useState(APPROVAL_TTL_MS);
  /** O pedido que morreu no relógio. O store limpa `pendingApproval` assim que a
   *  recusa é enviada, então sem esta cópia a mensagem de expiração piscaria e
   *  sumiria — e a pessoa nunca saberia por que a ferramenta não rodou. */
  const [expiredRequest, setExpiredRequest] = useState<ApprovalRequest | null>(null);
  /** Guarda contra recusar duas vezes o mesmo callId (o efeito roda de novo a
   *  cada tique do contador). */
  const refusedRef = useRef("");

  const callId = request?.callId ?? "";

  useEffect(() => {
    if (callId === "") return;
    setExpiredRequest(null);
    // O prazo é calculado por horário-alvo, e não somando tiques: intervalo de
    // 1s atrasa quando a aba fica em segundo plano, e o contador mentiria.
    const deadline = Date.now() + APPROVAL_TTL_MS;
    setRemaining(APPROVAL_TTL_MS);
    const timer = window.setInterval(() => {
      setRemaining(Math.max(0, deadline - Date.now()));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [callId]);

  useEffect(() => {
    if (!request || remaining > 0) return;
    if (refusedRef.current === request.callId) return;
    refusedRef.current = request.callId;
    setExpiredRequest(request);
    decide(request.callId, false, "once");
  }, [request, remaining, decide]);

  const shown = request ?? expiredRequest;
  if (!shown) return null;

  const expired = !request || remaining <= 0;
  const hasDigest = typeof shown.digest === "string" && shown.digest.length > 0;
  // A entrega tem corpo e botões PRÓPRIOS no mesmo funil: o resto do cartão
  // (fila, contador, expiração-que-recusa) continua idêntico de propósito. O
  // summary entra no parse porque as contagens REAIS moram nele — a lista do
  // detail vem capada em turnos grandes (ver lib/entrega.ts).
  const entrega = ehEntrega(shown) ? parseEntrega(shown.detail, shown.summary) : null;

  return (
    <div className="approval-backdrop">
      <section
        className="approval-card"
        data-risk={shown.risk}
        data-expired={expired}
        data-entrega={entrega ? "true" : undefined}
        role="alertdialog"
        aria-labelledby="approval-tool"
        aria-describedby="approval-summary"
      >
        <header className="approval-head">
          {entrega ? <PackageCheck size={16} aria-hidden /> : <ShieldCheck size={16} aria-hidden />}
          <h2 id="approval-tool" className="approval-tool">
            {/* O título fala o GESTO, não o id da ferramenta: "workspace.promote"
                não diz a ninguém que é o próprio projeto que vai mudar. */}
            {entrega ? "entregar ao projeto" : shown.tool}
          </h2>
          <span className="risk-badge" data-risk={shown.risk} title={RISK_HINT[shown.risk]}>
            {RISK_LABEL[shown.risk]}
          </span>
          <span className="approval-clock" data-expired={expired}>
            <Clock size={13} aria-hidden />
            {expired ? "expirado" : `expira em ${clock(remaining)}`}
          </span>
          {waiting > 0 ? (
            // Sem este contador, decidir um cartão e ver outro aparecer no lugar
            // parece defeito — e é justamente o que acontece numa onda de equipe.
            <span
              className="approval-queue"
              title="Outros pedidos desta onda esperando decisão"
              aria-label={`mais ${waiting} pedido(s) na fila`}
            >
              +{waiting} na fila
            </span>
          ) : null}
        </header>

        <p id="approval-summary" className="approval-summary">
          {shown.summary}
        </p>

        {entrega ? (
          // A lista de caminhos ABERTA (ver CorpoDaEntrega) substitui o
          // <details> genérico: aqui o detalhe é o próprio objeto da decisão.
          <CorpoDaEntrega entrega={entrega} />
        ) : shown.detail ? (
          <details className="approval-detail">
            <summary>Ver o detalhe</summary>
            <pre>{shown.detail}</pre>
          </details>
        ) : null}

        {expired ? (
          <p className="approval-expired" role="status">
            <AlertTriangle size={14} aria-hidden />
            {entrega
              ? "Este pedido expirou — a entrega foi recusada e o rascunho do turno, descartado. Peça de novo se ainda quiser entregar."
              : "Este pedido expirou — a execução foi recusada. Peça de novo se ainda quiser rodar."}
          </p>
        ) : (
          <p className="approval-note">
            {entrega
              ? "Recusar descarta o que o turno preparou — nada muda no projeto. O prazo é de dez minutos; passou disso, a entrega é recusada sozinha."
              : "Vale só para este pedido. O prazo é de dez minutos; passou disso, a execução é recusada sozinha."}
          </p>
        )}

        <footer className="approval-actions">
          {entrega ? (
            // Dois botões só: entrega não tem "lembrar destes argumentos" —
            // cada promoção é única (outro staging, outro digest), então o
            // escopo por digest nunca reaproveitaria nada.
            <button
              type="button"
              className="button-primary"
              disabled={expired}
              onClick={() => decide(shown.callId, true, "once")}
            >
              <Check size={14} aria-hidden />
              Permitir entrega
            </button>
          ) : (
            <>
              <button
                type="button"
                className="button-primary"
                disabled={expired}
                onClick={() => decide(shown.callId, true, "once")}
              >
                <Check size={14} aria-hidden />
                Permitir uma vez
              </button>

              <button
                type="button"
                className="button-secondary"
                disabled={expired || !hasDigest}
                title={
                  hasDigest
                    ? `Vale para estes argumentos exatos (digest ${shown.digest})`
                    : "O gateway não mandou o digest destes argumentos, então não dá para lembrar deles"
                }
                onClick={() => decide(shown.callId, true, "digest")}
              >
                <Check size={14} aria-hidden />
                Permitir estes argumentos
              </button>
            </>
          )}

          <button
            type="button"
            className="button-danger"
            disabled={expired}
            onClick={() => decide(shown.callId, false, "once")}
          >
            <X size={14} aria-hidden />
            Recusar
          </button>

          {expired ? (
            <button type="button" className="button-quiet" onClick={() => setExpiredRequest(null)}>
              Fechar
            </button>
          ) : null}
        </footer>
      </section>
    </div>
  );
}

export default ApprovalCard;
