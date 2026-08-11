/**
 * Primitivos de superfície — TODA aba compõe a tela com estes blocos.
 * É isto que garante geometria idêntica entre os modos.
 */
import type { CSSProperties, ReactNode } from "react";
import { createPortal } from "react-dom";
import { Sparkles } from "lucide-react";

/**
 * Slot dinâmico na barra superior do app (antes do status de conexão).
 * As views injetam aqui suas ações — nada de toolbar interna ocupando a
 * área de trabalho. O alvo é renderizado pelo App antes das views montarem.
 */
export function TopbarActions({ children }: { children: ReactNode }) {
  const target = document.getElementById("topbar-actions");
  if (!target) return null;
  // O alvo é estável; a view remonta por aba, então o wrapper anima a entrada.
  return createPortal(<div className="slot-inner">{children}</div>, target);
}

export function Surface({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <section className={`surface ${className}`}>{children}</section>;
}

export function VToolbar({ children }: { children: ReactNode }) {
  return <header className="v-toolbar">{children}</header>;
}

export function DocIdentity({ icon, title, detail }: { icon: ReactNode; title: string; detail: string }) {
  return (
    <div className="doc-identity">
      <span>{icon}</span>
      <div>
        <strong>{title}</strong>
        <small>{detail}</small>
      </div>
    </div>
  );
}

export function VBody({ children }: { children: ReactNode }) {
  return <div className="v-body">{children}</div>;
}

export function VLeft({ children }: { children: ReactNode }) {
  return <aside className="v-left v-panel">{children}</aside>;
}

export function VRight({ children }: { children: ReactNode }) {
  return <aside className="v-right v-panel">{children}</aside>;
}

export function VCenter({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <main className={`v-center ${className}`}>{children}</main>;
}

/**
 * Rodapé de status: renderiza por portal no slot global do App, ABAIXO do
 * composer — o balão de input vem antes do rodapé em todas as janelas.
 */
export function VStatus({ children }: { children: ReactNode }) {
  const target = document.getElementById("statusbar-slot");
  if (!target) return null;
  return createPortal(<div className="slot-inner">{children}</div>, target);
}

export function PanelTitle({
  icon,
  label,
  meta,
  action
}: {
  icon?: ReactNode;
  label: string;
  meta?: string;
  action?: ReactNode;
}) {
  return (
    <div className="panel-title">
      <span>
        {icon}
        {label}
      </span>
      {meta && <small>{meta}</small>}
      {action}
    </div>
  );
}

export function PanelScroll({ children }: { children: ReactNode }) {
  return <div className="panel-scroll">{children}</div>;
}

export function RowItem({
  icon,
  label,
  meta,
  active,
  onClick,
  trailing
}: {
  icon?: ReactNode;
  label: string;
  meta?: string;
  active?: boolean;
  onClick?: () => void;
  trailing?: ReactNode;
}) {
  return (
    <button className={`row-item ${active ? "active" : ""}`} onClick={onClick} title={label}>
      {icon}
      <span className="grow">{label}</span>
      {meta && <small>{meta}</small>}
      {trailing}
    </button>
  );
}

export function EmptyHero({
  icon,
  kicker,
  title,
  detail,
  children
}: {
  icon: ReactNode;
  kicker: string;
  title: string;
  detail: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty-hero">
      <div className="hero-lens">
        {icon}
        <i />
      </div>
      <span className="eyebrow">{kicker}</span>
      <h1>{title}</h1>
      <p>{detail}</p>
      {children}
    </div>
  );
}

export function PromptCards({ prompts, onPrompt }: { prompts: string[]; onPrompt: (prompt: string) => void }) {
  return (
    <div className="prompt-cards">
      {prompts.map((prompt, index) => (
        <button key={prompt} onClick={() => onPrompt(prompt)}>
          <span>0{index + 1}</span>
          <strong>{prompt}</strong>
          <Sparkles size={14} />
        </button>
      ))}
    </div>
  );
}

export function ProcessPulse({ label, detail }: { label: string; detail: string }) {
  return (
    <div className="process-pulse" role="status" aria-live="polite">
      <span className="particle-sphere" aria-hidden="true">
        <i className="particle-core" />
        {Array.from({ length: 24 }, (_, index) => (
          <i
            className="burst-particle"
            key={index}
            style={
              {
                "--angle": `${index * 15}deg`,
                "--distance": `${17 + (index % 6) * 3}px`,
                "--delay": `${-(index % 8) * 95}ms`
              } as CSSProperties
            }
          />
        ))}
      </span>
      <span className="process-copy">
        <strong>
          {label}
          <i />
          <i />
          <i />
        </strong>
        <small>{detail}</small>
      </span>
    </div>
  );
}

/** Pulse flutuante padronizado no topo do centro da superfície. */
export function FloatingPulse({ label, detail }: { label: string; detail: string }) {
  return (
    <div style={{ position: "absolute", top: 10, left: "50%", transform: "translateX(-50%)", zIndex: 40 }}>
      <ProcessPulse label={label} detail={detail} />
    </div>
  );
}
