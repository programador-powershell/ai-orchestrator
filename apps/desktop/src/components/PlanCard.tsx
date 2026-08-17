import { AlertTriangle, Check, ListChecks, Play, X } from "lucide-react";
import type { ExecutionPlan } from "@orchestrator/contracts";

export function PlanCard({
  plan,
  executing,
  onApprove,
  onDismiss
}: {
  plan: ExecutionPlan;
  executing: boolean;
  onApprove: () => void;
  onDismiss: () => void;
}) {
  return (
    <section className="plan-card glass-strong" aria-label="Plano de execução">
      <header>
        <span className="chip accent">
          <ListChecks size={12} />
          Modo planejamento
        </span>
        <div>
          <strong>{plan.title}</strong>
          {plan.summary && <small> — {plan.summary}</small>}
        </div>
      </header>
      <div className="plan-steps">
        {plan.steps.map((step, index) => (
          <div className={`plan-step ${step.status}`} key={step.id}>
            <span>{step.status === "done" ? <Check size={12} /> : String(index + 1).padStart(2, "0")}</span>
            <div>
              {step.title}
              {step.detail && <small>{step.detail}</small>}
            </div>
            <small className="eyebrow">{step.status === "pending" ? "" : step.status}</small>
          </div>
        ))}
      </div>
      {plan.risks.length > 0 && (
        <div className="plan-risks">
          {plan.risks.map((risk) => (
            <span key={risk}>
              <AlertTriangle size={11} style={{ verticalAlign: "-2px", marginRight: 5 }} />
              {risk}
            </span>
          ))}
        </div>
      )}
      <div className="plan-actions">
        <button className="lg-button ghost" onClick={onDismiss} disabled={executing}>
          <X size={14} />
          Descartar
        </button>
        <button className="lg-button primary" onClick={onApprove} disabled={executing}>
          <Play size={14} />
          {executing ? "Executando…" : "Aprovar e executar"}
        </button>
      </div>
    </section>
  );
}
