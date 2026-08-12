"use client";

/**
 * Seletor de política de aprovação no composer.
 *
 * Antes era um chip somente-leitura que abria as Configurações — e como ele
 * nascia colado no toggle "Ferramentas", clicar num acabava abrindo o modal do
 * outro. Agora é o controle de verdade, no mesmo lugar onde a política importa.
 * As Configurações continuam sendo superfície de escrita (Motores & Fusion).
 */

import { useEffect, useRef, useState } from "react";
import { Check, ShieldCheck } from "lucide-react";
import { APPROVAL_POLICIES, policyLabel, type ApprovalPolicy } from "../lib/approval";

interface Props {
  policy: ApprovalPolicy;
  onChange: (policy: ApprovalPolicy) => void;
  /** Trocar a política no meio de um turno não vale para as chamadas em voo. */
  disabled?: boolean;
}

export function ApprovalSelect({ policy, onChange, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Fecha ao clicar fora ou no Esc — o popover não pode ficar preso aberto
  // por cima da conversa.
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  return (
    <div className="approve-select" ref={rootRef}>
      <button
        type="button"
        className="approve-chip"
        onClick={() => setOpen((value) => !value)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={
          disabled
            ? "A política não muda no meio de um turno"
            : APPROVAL_POLICIES.find((item) => item.id === policy)?.hint
        }
      >
        <ShieldCheck size={12} />
        {policyLabel(policy)}
      </button>
      {open ? (
        <div className="approve-menu glass-strong" role="listbox" aria-label="Política de aprovação">
          {APPROVAL_POLICIES.map((item) => (
            <button
              key={item.id}
              type="button"
              role="option"
              aria-selected={item.id === policy}
              className={`approve-option${item.id === policy ? " is-active" : ""}`}
              onClick={() => {
                onChange(item.id);
                setOpen(false);
              }}
            >
              <span className="approve-option__mark" aria-hidden>
                {item.id === policy ? <Check size={12} /> : null}
              </span>
              <span className="approve-option__text">
                <strong>{item.label}</strong>
                <small>{item.hint}</small>
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
