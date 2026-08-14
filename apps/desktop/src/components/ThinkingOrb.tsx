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
 *
 * ## Dois desenhos, uma porta
 *
 * Nos tamanhos grandes quem desenha é o `thinking-orbs` (canvas, homologado):
 * são nove animações tunadas à mão, de outra categoria de acabamento. Ele tem
 * DOIS tamanhos, 20 e 64, que a própria biblioteca descreve como desenhos
 * separados — não é um fator de escala, e passar outro número quebra a busca
 * do preset.
 *
 * Abaixo de 20px o desenho volta a ser o glifo SVG do pacote de ícones, por
 * dois motivos: naquele tamanho o pontilhado do canvas não se distingue de um
 * borrão, e o glifo herda `currentColor`, então a marca continua na matiz do
 * módulo — que é o que amarra o indicador à aba em que ele aparece.
 *
 * Os dois moram atrás do MESMO componente: nenhum ponto de chamada sabe qual
 * está em uso, e a régua fica escrita num lugar só.
 */

import { useMemo } from "react";
import { ThinkingOrb as OrbeTunado, type OrbSize } from "thinking-orbs";

import { Glyph } from "./icons";

/**
 * Os nove estados. Os nomes são os mesmos do `thinking-orbs` e dos SVGs do
 * pacote de ícones — a coincidência não é acidental, os dois vieram do mesmo
 * desenho, e é ela que deixa a troca de renderizador ser invisível aqui.
 */
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

/** Menor tamanho com desenho tunado na biblioteca. Abaixo disso, glifo. */
const MENOR_TUNADO = 20;
/** Acima disto vale o desenho grande, com mais pontos e outra cadência. */
const LIMITE_GRANDE = 40;

/**
 * Palavras que denunciam a etapa, do mais específico para o mais genérico.
 *
 * A ordem importa: "revisando o plano" é conferência, não escrita, e cairia no
 * orbe errado se "plano" fosse testado antes de "revis".
 */
const PISTAS: Array<[ThinkingKind, RegExp]> = [
  // Os ids de ferramenta entram junto: o composer escreve
  // `setStage("Ferramenta: fs_read")`, em inglês e sem verbo, e sem eles
  // cinco das sete ferramentas mostravam o orbe de REPOUSO enquanto rodavam.
  ["searching", /busca|buscando|pesquis|procur|fonte|indexa|varre|consult|recuper|mem[óo]ria|fs_read|fs_list|web_search|\bsearch\b/i],
  ["solving", /revis|analis|verific|conferi|diagn[óo]stic|avali|valid|testa|lint|auditor/i],
  ["shaping", /desenh|layout|design|renderiz|estiliz|captur|imagem|v[íi]deo|quadro|generate_image/i],
  ["weaving", /montand|orquestr|deleg|equipe|agente|fluxo|plano|planej|escal|coorden|fusion/i],
  ["connecting", /conect|gateway|enviand|carreg|abrind|sincroniz|baixand|subind|publicand/i],
  ["listening", /aguard|esperand|ouvind|transcrev|escutand|fila/i],
  ["composing", /escrev|redig|gerand|compond|respond|traduz|resum|documenta|fs_write/i],
  ["working", /execut|rodand|aplicand|compil|build|instal|migrand|process|treinand|terminal/i]
];

/** Deduz o orbe pelo texto da etapa. Sem pista, respira. */
export function thinkingKindFor(text: string | null | undefined): ThinkingKind {
  if (!text) return "breathing";
  for (const [kind, padrao] of PISTAS) {
    if (padrao.test(text)) return kind;
  }
  return "breathing";
}

/** Qual desenho da biblioteca cabe no espaço pedido — ou nenhum. */
export function presetPara(size: number): OrbSize | null {
  if (size >= LIMITE_GRANDE) return 64;
  if (size >= MENOR_TUNADO) return 20;
  return null;
}

export interface ThinkingOrbProps {
  /** Fixa o orbe. Sem isto, ele é deduzido de `label`. */
  kind?: ThinkingKind;
  label?: string;
  size?: number;
  className?: string;
}

/** Só o orbe animado, sem texto — para caber em botões, chips e listas. */
export function ThinkingOrb({ kind, label, size = 20, className = "" }: ThinkingOrbProps) {
  const tipo = useMemo(() => kind ?? thinkingKindFor(label), [kind, label]);
  const preset = presetPara(size);

  if (preset) {
    return (
      <span className={`orb orb--tunado ${className}`} aria-hidden="true">
        {/*
         * `theme="auto"` acha o `data-theme` do `.app-shell` subindo pelos
         * ancestrais — é a mesma convenção que o app já usa, então claro⇄escuro
         * acompanha sem configuração. A biblioteca também trata
         * `prefers-reduced-motion` sozinha (congela num quadro) e para de
         * animar fora da tela e com a janela oculta.
         */}
        <OrbeTunado state={tipo} size={preset} />
      </span>
    );
  }

  return (
    <span className={`orb orb--${tipo} ${className}`} aria-hidden="true">
      {/* Sem cast: `GlyphName` é a união literal das chaves geradas, então o
          template só compila porque os nove `thinking/*` existem mesmo. */}
      <Glyph name={`thinking/${tipo}`} size={size} strokeWidth={1.4} />
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
