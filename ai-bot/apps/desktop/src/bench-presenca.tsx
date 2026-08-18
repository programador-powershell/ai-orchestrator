/** BANCADA TEMPORÁRIA — motor profissional v3 × estados, com o stand-in do Lab. Não versionar. */

import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import { GrokAvatar, GROK_STATE_LABELS, type GrokSpecialist, type GrokSpecialistState } from "./avatar/GrokAvatar";

const ESPECIALISTAS: GrokSpecialist[] = ["chat", "code", "data", "design", "agent", "flow", "tuning", "security"];
const ESTADOS: GrokSpecialistState[] = ["active", "owner", "working", "waiting", "completed"];
const NOMES: Record<GrokSpecialist, string> = {
  chat: "Chat",
  code: "Code",
  data: "Data",
  design: "Design",
  agent: "Agent",
  flow: "Fluxo",
  tuning: "Tuning",
  security: "Security"
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
      <GrokAvatar specialist="code" state={estado} size={210} />
      <strong style={{ fontSize: 12, letterSpacing: "0.1em", textTransform: "uppercase", opacity: 0.75 }}>
        Code — {GROK_STATE_LABELS[estado]} (ciclando)
      </strong>
    </div>
  );
}

function Bancada() {
  return (
    <div style={{ minHeight: "100vh", padding: 24, background: "#101012", color: "#e8e8e8", fontFamily: "system-ui", overflow: "auto" }}>
      <table style={{ borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th style={{ padding: 6 }}>
              <Ciclador />
            </th>
            {ESTADOS.map((estado) => (
              <th key={estado} style={{ padding: 6, fontSize: 12, opacity: 0.65 }}>
                {GROK_STATE_LABELS[estado]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ESPECIALISTAS.map((specialist) => (
            <tr key={specialist}>
              <th style={{ padding: 6, fontSize: 12, opacity: 0.65, textAlign: "right" }}>{NOMES[specialist]}</th>
              {ESTADOS.map((estado) => (
                <td key={estado} style={{ padding: 2, border: "1px solid #ffffff12", textAlign: "center" }}>
                  <GrokAvatar specialist={specialist} state={estado} size={116} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Bancada />
  </StrictMode>
);
