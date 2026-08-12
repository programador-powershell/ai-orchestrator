/**
 * Bloco "Pensando" — o raciocínio do modelo aparece recolhido, acima da
 * resposta, como no Unsloth Studio. Fica aberto enquanto o modelo pensa (para
 * o usuário ver que há progresso) e recolhe sozinho quando a resposta começa.
 */
import { memo, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Lightbulb } from "lucide-react";
import { Markdown } from "./Markdown";

interface ReasoningBlockProps {
  text: string;
  /** true enquanto o modelo ainda está pensando (nenhuma resposta ainda). */
  active: boolean;
}

export const ReasoningBlock = memo(function ReasoningBlock({ text, active }: ReasoningBlockProps) {
  const [open, setOpen] = useState(active);
  const [manual, setManual] = useState(false);

  // Recolhe sozinho quando o raciocínio termina — a não ser que o usuário
  // tenha aberto/fechado manualmente (aí a escolha dele manda).
  useEffect(() => {
    if (!manual) setOpen(active);
  }, [active, manual]);

  if (!text.trim()) return null;

  return (
    <div className={`reasoning ${active ? "active" : ""}`}>
      <button
        className="reasoning-head"
        onClick={() => {
          setManual(true);
          setOpen((value) => !value);
        }}
        aria-expanded={open}
      >
        <Lightbulb size={12} />
        <span>{active ? "Pensando…" : "Raciocínio"}</span>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
      </button>
      {open && (
        <div className="reasoning-body">
          <Markdown source={text} />
        </div>
      )}
    </div>
  );
});
