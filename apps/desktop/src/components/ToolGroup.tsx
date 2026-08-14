/**
 * Grupo de ferramentas na conversa — estilo Studio: cabeçalho recolhível
 * "N tool calls", linhas "Used tool: X" com status, saída em bloco e, na
 * busca, chips de fonte com o domínio.
 */
import { useState } from "react";
import { ChevronDown, ChevronRight, Circle, Globe, TriangleAlert, Check } from "lucide-react";
import { runningCount, toolLabel, type ToolCard, type ToolEdit } from "../lib/toolcard";
import { editLabel } from "../lib/toolEdit";
import { ThinkingOrb, type ThinkingKind } from "./ThinkingOrb";

/**
 * Qual orbe cada ferramenta acende.
 *
 * Aqui o mapa é EXPLÍCITO, e não deduzido do rótulo como no resto do app: o
 * conjunto de ferramentas é fechado e os rótulos são em inglês ("Searched",
 * "Ran"), então adivinhar pelo texto erraria em quase todos.
 */
const ORBE_DA_FERRAMENTA: Record<string, ThinkingKind> = {
  fs_read: "searching",
  fs_list: "searching",
  search: "searching",
  web_search: "searching",
  fs_write: "composing",
  generate_image: "shaping",
  terminal: "working",
  fusion_executor: "working"
};

function StatusIcon({ card }: { card: ToolCard }) {
  if (card.status === "running") {
    return <ThinkingOrb kind={ORBE_DA_FERRAMENTA[card.tool] ?? "working"} size={12} className="orb--inline" />;
  }
  if (card.status === "error") return <TriangleAlert size={11} />;
  return <Check size={11} />;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * Diff da edição, recolhível: cabeçalho "Criado x.ts +44 −0" + linhas.
 *
 * Fica FORA do ToolGroup de propósito. Declarada dentro do render, ela virava
 * uma função nova a cada atualização de cartão — e o React, vendo outro tipo
 * de componente, desmontava e remontava a subárvore, zerando o `expanded`. Na
 * prática era impossível ler um diff enquanto o agente ainda executava: cada
 * token recolhia o que a pessoa tinha acabado de abrir.
 */
function EditDiff({ edit }: { edit: ToolEdit }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="tooledit">
      <button className="tooledit-head" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
        {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        <span className="tooledit-label">{editLabel(edit)}</span>
      </button>
      {expanded && (
        <pre className="tooledit-patch">
          {edit.patch.split("\n").map((line, index) => (
            <span
              key={index}
              className={line.startsWith("+") ? "add" : line.startsWith("-") ? "remove" : line.startsWith("…") ? "skip" : ""}
            >
              {line}
            </span>
          ))}
        </pre>
      )}
    </div>
  );
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
        {running ? <ThinkingOrb kind="working" size={12} className="orb--inline" /> : <Circle size={9} />}
        <span>
          {cards.length} tool call{cards.length === 1 ? "" : "s"}
        </span>
      </button>
      {open && (
        <div className="toolgroup-body">
          {cards.map((card, index) => (
            <div key={index} className={`toolcall ${card.status}`}>
              <div className="toolcall-head">
                <StatusIcon card={card} />
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
              {card.images && card.images.length > 0 && (
                <div className="toolcall-images">
                  {card.images.map((src) => (
                    <img key={src} src={src} alt="Imagem gerada pelo agente" loading="lazy" />
                  ))}
                </div>
              )}
              {card.edit && <EditDiff edit={card.edit} />}
              {card.output && !card.edit && <pre className="toolcall-output">{card.output}</pre>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
