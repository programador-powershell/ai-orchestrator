/** BANCADA TEMPORÁRIA — presença profissional Grok, 8 especialistas × 5 estados. */

import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { GrokAvatar, GROK_STATE_LABELS, type GrokSpecialist, type GrokSpecialistState } from "./avatar/GrokAvatar";

const ESPECIALISTAS: GrokSpecialist[] = ["chat", "code", "data", "design", "agent", "flow", "tuning", "security"];
const ESTADOS: GrokSpecialistState[] = ["active", "owner", "working", "waiting", "completed"];
const NOMES: Record<GrokSpecialist, string> = {
  chat: "Chat", code: "Code", data: "Data", design: "Design",
  agent: "Agent", flow: "Fluxo", tuning: "Tuning", security: "Security"
};

function Ciclador() {
  const [indice, setIndice] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setIndice((atual) => (atual + 1) % ESTADOS.length), 3000);
    return () => clearInterval(timer);
  }, []);
  const estado = ESTADOS[indice] ?? "active";
  return (
    <div style={{ display: "grid", justifyItems: "center", gap: 6 }}>
      <GrokAvatar specialist="code" state={estado} size={220} />
      <strong style={{ fontSize: 12, letterSpacing: "0.1em", textTransform: "uppercase", opacity: 0.75 }}>
        Code — {GROK_STATE_LABELS[estado]} (ciclando)
      </strong>
    </div>
  );
}

function Bancada() {
  return (
    <div style={{ minHeight: "100vh", padding: 24, background: "#101012", color: "#e8e8e8", fontFamily: "system-ui", overflow: "auto" }}>
      <h2 style={{ fontSize: 17, margin: "0 0 4px" }}>Atividade profissional — Trabalhando</h2>
      <p style={{ margin: "0 0 16px", opacity: 0.58, fontSize: 12 }}>
        O corpo NÃO é uma esfera com ícone: a própria massa preta se deforma e vira o gesto profissional — pseudópodes digitam, perseguem dados, arrastam Bézier, brotam subagentes, fluem pelos nodes, ajustam knobs e viram escudo.
      </p>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 220px)", gap: 12, marginBottom: 34 }}>
        {ESPECIALISTAS.map((specialist) => (
          <div key={specialist} style={{ minHeight: 238, display: "grid", justifyItems: "center", alignContent: "center", border: "1px solid #ffffff14", borderRadius: 14, background: "#141416" }}>
            <GrokAvatar specialist={specialist} state="working" size={200} />
            <strong style={{ fontSize: 12, opacity: 0.72 }}>{NOMES[specialist]}</strong>
          </div>
        ))}
      </div>

      <h2 style={{ fontSize: 17, margin: "0 0 10px" }}>8 especialistas × 5 estados</h2>
      <table style={{ borderCollapse: "collapse" }}>
        <thead><tr>
          <th style={{ padding: 6 }}><Ciclador /></th>
          {ESTADOS.map((estado) => <th key={estado} style={{ padding: 6, fontSize: 12, opacity: 0.65 }}>{GROK_STATE_LABELS[estado]}</th>)}
        </tr></thead>
        <tbody>
          {ESPECIALISTAS.map((specialist) => (
            <tr key={specialist}>
              <th style={{ padding: 6, fontSize: 12, opacity: 0.65, textAlign: "right" }}>{NOMES[specialist]}</th>
              {ESTADOS.map((estado) => (
                <td key={estado} style={{ padding: 4, border: "1px solid #ffffff12", textAlign: "center" }}>
                  <GrokAvatar specialist={specialist} state={estado} size={132} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><Bancada /></StrictMode>);
