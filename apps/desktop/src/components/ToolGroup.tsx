/**
 * Grupo de ferramentas na conversa — estilo Studio: cabeçalho recolhível
 * "N tool calls", linhas "Used tool: X" com status, saída em bloco e, na
 * busca, chips de fonte com o domínio.
 */
import { useState } from "react";
import { ChevronDown, ChevronRight, Circle, Globe, LoaderCircle, TriangleAlert, Check } from "lucide-react";
import { runningCount, toolLabel, type ToolCard } from "../lib/toolcard";

function StatusIcon({ status }: { status: ToolCard["status"] }) {
  if (status === "running") return <LoaderCircle size={11} className="spin" />;
  if (status === "error") return <TriangleAlert size={11} />;
  return <Check size={11} />;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function ToolGroup({ cards }: { cards: ToolCard[] }) {
  const running = runningCount(cards);
  // Aberto enquanto executa (o usuário vê o progresso), recolhe ao terminar.
  const [openOverride, setOpenOverride] = useState<boolean | null>(null);
  const open = openOverride ?? running > 0;

  if (!cards.length) return null;

  return (
    <div className={`toolgroup ${running ? "running" : ""}`}>
      <button className="toolgroup-head" onClick={() => setOpenOverride(!open)} aria-expanded={open}>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {running ? <LoaderCircle size={11} className="spin" /> : <Circle size={9} />}
        <span>
          {cards.length} tool call{cards.length === 1 ? "" : "s"}
        </span>
      </button>
      {open && (
        <div className="toolgroup-body">
          {cards.map((card, index) => (
            <div key={index} className={`toolcall ${card.status}`}>
              <div className="toolcall-head">
                <StatusIcon status={card.status} />
                <span className="toolcall-label">
                  <em>Used tool:</em> {toolLabel(card)}
                </span>
              </div>
              {card.sources && card.sources.length > 0 && (
                <div className="toolcall-sources">
                  {card.sources.map((source) => (
                    <a
                      key={source.url}
                      className="source-chip"
                      href={source.url}
                      target="_blank"
                      rel="noreferrer"
                      title={source.url}
                    >
                      <Globe size={10} />
                      <span>{source.title || hostOf(source.url)}</span>
                      <small>{hostOf(source.url)}</small>
                    </a>
                  ))}
                </div>
              )}
              {card.output && <pre className="toolcall-output">{card.output}</pre>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
