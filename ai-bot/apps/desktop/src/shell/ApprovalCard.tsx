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
 */
import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, Clock, ShieldCheck, X } from "lucide-react";
import type { ApprovalRequest, Risk } from "@aibot/contracts";
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

export function ApprovalCard() {
  const request = useApp((state) => state.pendingApproval);
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

  return (
    <div className="approval-backdrop">
      <section
        className="approval-card"
        data-risk={shown.risk}
        data-expired={expired}
        role="alertdialog"
        aria-labelledby="approval-tool"
        aria-describedby="approval-summary"
      >
        <header className="approval-head">
          <ShieldCheck size={16} aria-hidden />
          <h2 id="approval-tool" className="approval-tool">
            {shown.tool}
          </h2>
          <span className="risk-badge" data-risk={shown.risk} title={RISK_HINT[shown.risk]}>
            {RISK_LABEL[shown.risk]}
          </span>
          <span className="approval-clock" data-expired={expired}>
            <Clock size={13} aria-hidden />
            {expired ? "expirado" : `expira em ${clock(remaining)}`}
          </span>
        </header>

        <p id="approval-summary" className="approval-summary">
          {shown.summary}
        </p>

        {shown.detail ? (
          <details className="approval-detail">
            <summary>Ver o detalhe</summary>
            <pre>{shown.detail}</pre>
          </details>
        ) : null}

        {expired ? (
          <p className="approval-expired" role="status">
            <AlertTriangle size={14} aria-hidden />
            Este pedido expirou — a execução foi recusada. Peça de novo se ainda quiser rodar.
          </p>
        ) : (
          <p className="approval-note">
            Vale só para este pedido. O prazo é de dez minutos; passou disso, a execução é recusada sozinha.
          </p>
        )}

        <footer className="approval-actions">
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
