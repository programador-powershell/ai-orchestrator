"use client";

/**
 * ORBE DE PROCESSAMENTO — o app diz o que está fazendo, não só que está ocupado.
 *
 * Um spinner responde "espere"; nove orbes respondem "espere, estou buscando
 * fontes" / "estou montando o fluxo" / "estou conferindo o resultado". A forma
 * carrega a informação, então o rodapé de texto vira confirmação em vez de ser
 * a única pista.
 *
 * O tipo é DEDUZIDO do texto de etapa que as abas já escrevem no store
 * (`setStage`). Foi de propósito: obrigar cada aba a escolher um orbe daria
 * dezenas de pontos para esquecer um, e o app voltaria ao spinner mudo em
 * metade das telas. Quem quiser mandar no orbe passa `kind` e pronto.
 */

import { useMemo } from "react";

import { Glyph, type GlyphName } from "./icons";

export type ThinkingKind =
  | "breathing"
  | "composing"
  | "connecting"
  | "listening"
  | "searching"
  | "shaping"
  | "solving"
  | "weaving"
  | "working";

/**
 * Palavras que denunciam a etapa, do mais específico para o mais genérico.
 *
 * A ordem importa: "revisando o plano" é conferência, não escrita, e cairia no
 * orbe errado se "plano" fosse testado antes de "revis".
 */
const PISTAS: Array<[ThinkingKind, RegExp]> = [
  ["searching", /busca|buscando|pesquis|procur|fonte|indexa|varre|consult|recuper|mem[óo]ria/i],
  ["solving", /revis|analis|verific|conferi|diagn[óo]stic|avali|valid|testa|lint|auditor/i],
  ["shaping", /desenh|layout|design|renderiz|estiliz|captur|imagem|v[íi]deo|quadro/i],
  ["weaving", /montand|orquestr|deleg|equipe|agente|fluxo|plano|planej|escal|coorden/i],
  ["connecting", /conect|gateway|enviand|carreg|abrind|sincroniz|baixand|subind|publicand/i],
  ["listening", /aguard|esperand|ouvind|transcrev|escutand|fila/i],
  ["composing", /escrev|redig|gerand|compond|respond|traduz|resum|documenta/i],
  ["working", /execut|rodand|aplicand|compil|build|instal|migrand|process|treinand/i]
];

/** Deduz o orbe pelo texto da etapa. Sem pista, respira. */
export function thinkingKindFor(text: string | null | undefined): ThinkingKind {
  if (!text) return "breathing";
  for (const [kind, padrao] of PISTAS) {
    if (padrao.test(text)) return kind;
  }
  return "breathing";
}

export interface ThinkingOrbProps {
  /** Fixa o orbe. Sem isto, ele é deduzido de `label`. */
  kind?: ThinkingKind;
  label?: string;
  size?: number;
  className?: string;
}

/** Só o orbe animado, sem texto — para caber em botões, chips e listas. */
export function ThinkingOrb({ kind, label, size = 18, className = "" }: ThinkingOrbProps) {
  const tipo = useMemo(() => kind ?? thinkingKindFor(label), [kind, label]);
  return (
    <span className={`orb orb--${tipo} ${className}`} aria-hidden="true">
      <Glyph name={`thinking/${tipo}` as GlyphName} size={size} strokeWidth={1.4} />
    </span>
  );
}

export interface ThinkingIndicatorProps extends ThinkingOrbProps {
  detail?: string;
}

/**
 * Orbe + texto, o bloco que aparece enquanto a resposta não veio.
 *
 * `role="status"` com `aria-live="polite"` porque a mudança de etapa precisa
 * chegar a quem usa leitor de tela — é a única indicação de que o app não
 * travou.
 */
export function ThinkingIndicator({ kind, label = "Processando", detail, size = 20, className = "" }: ThinkingIndicatorProps) {
  const tipo = useMemo(() => kind ?? thinkingKindFor(label), [kind, label]);
  return (
    <div className={`thinking ${className}`} role="status" aria-live="polite">
      <ThinkingOrb kind={tipo} size={size} />
      <span className="thinking-copy">
        <strong>
          {label}
          <i />
          <i />
          <i />
        </strong>
        {detail ? <small>{detail}</small> : null}
      </span>
    </div>
  );
}
