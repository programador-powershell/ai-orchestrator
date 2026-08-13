"use client";

/**
 * Painel do sistema de design — o contrato de marca da aba Design.
 *
 * O documento sozinho é enfeite. O que faz ele valer é o botão **Conferir**:
 * ele aponta, nó a nó, o que no canvas está fora da paleta, da escala e dos
 * raios declarados. E **Corrigir** aproxima cada valor solto do token mais
 * próximo, em vez de só reclamar.
 *
 * A paleta pode ser semeada a partir de um site clonado — padronizar uma marca
 * costuma começar por "quero a identidade daquele site".
 */

import { useEffect, useState } from "react";
import { CircleCheck, Download, Palette, TriangleAlert, Wand2 } from "lucide-react";
import type { CanvasDoc } from "../lib/canvasDoc";
import {
  applySystem,
  checkConformance,
  DESIGN_SYSTEM_KEY,
  emptySystem,
  isEmpty,
  normalizeHex,
  paletteWarnings,
  parseSystem,
  serializeSystem,
  systemFromTokens,
  toMarkdown,
  type DesignSystem,
  type Violation
} from "../lib/designSystem";

/** Lista de números separada por vírgula/espaço → array ordenado e limpo. */
function parseNumbers(text: string): number[] {
  return [
    ...new Set(
      text
        .split(/[\s,;]+/)
        .map((item) => Number.parseFloat(item))
        .filter((value) => Number.isFinite(value) && value >= 0)
    )
  ].sort((a, b) => a - b);
}

export function DesignSystemPanel({
  doc,
  onApply,
  onSelect,
  seedColors,
  seedFonts
}: {
  doc: CanvasDoc;
  onApply: (next: CanvasDoc) => void;
  onSelect: (nodeId: string) => void;
  /** Cores do último site clonado, para semear a paleta. */
  seedColors: string[];
  seedFonts: string[];
}) {
  const [system, setSystem] = useState<DesignSystem>(() => emptySystem());
  const [violations, setViolations] = useState<Violation[] | null>(null);
  const [note, setNote] = useState("");

  useEffect(() => {
    const salvo = parseSystem(window.localStorage.getItem(DESIGN_SYSTEM_KEY));
    if (salvo) setSystem(salvo);
  }, []);

  function commit(next: DesignSystem) {
    const carimbado = { ...next, updatedAt: Date.now() };
    setSystem(carimbado);
    // Editar o contrato invalida a conferência anterior — ela era sobre outras
    // regras, e mostrá-la ao lado do contrato novo seria enganoso.
    setViolations(null);
    try {
      window.localStorage.setItem(DESIGN_SYSTEM_KEY, serializeSystem(carimbado));
    } catch {
      // storage cheio: o contrato segue em memória nesta sessão
    }
  }

  function conferir() {
    setViolations(checkConformance(doc, system));
    setNote("");
  }

  function corrigir() {
    const next = applySystem(doc, system);
    if (next === doc) {
      setNote("nada a corrigir — o canvas já está conforme");
      return;
    }
    onApply(next);
    setViolations(checkConformance(next, system));
    setNote("canvas ajustado ao contrato");
  }

  function semear() {
    if (!seedColors.length && !seedFonts.length) {
      setNote("clone um site primeiro — a semente vem dos tokens dele");
      return;
    }
    commit(
      systemFromTokens(system.name, {
        colors: seedColors.map((value) => ({ value })),
        fonts: seedFonts
      })
    );
    setNote(`paleta semeada a partir do site (${seedColors.length} cor(es) lidas)`);
  }

  function exportar() {
    const blob = new Blob([toMarkdown(system)], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "DESIGN.md";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  const vazio = isEmpty(system);
  // Avisos sobre a PALETA — não sobre o canvas. Corrigir com paleta incompleta
  // pode eliminar contraste, e isso precisa aparecer antes de acontecer.
  const avisos = paletteWarnings(system);

  return (
    <div className="dsx">
      <div className="dsx-head">
        <input
          className="dsx-name"
          value={system.name}
          onChange={(event) => commit({ ...system, name: event.target.value })}
          aria-label="Nome do sistema de design"
        />
        <button className="lg-button ghost" onClick={semear} title="Usar os tokens do último site clonado">
          <Palette size={13} />
          Semear do site
        </button>
        <button className="lg-button ghost" onClick={exportar} title="Baixar como DESIGN.md para versionar no repositório">
          <Download size={13} />
        </button>
      </div>

      {vazio ? (
        <p className="dsx-empty">
          Sem regra nenhuma, o contrato não cobra nada e não entra nos prompts. Defina ao menos a paleta.
        </p>
      ) : null}

      {avisos.map((aviso) => (
        <p className="dsx-empty" key={aviso}>
          <TriangleAlert size={11} /> {aviso}
        </p>
      ))}

      <label className="dsx-field">
        Paleta
        <textarea
          rows={4}
          placeholder="primária #2563eb&#10;tinta #111827"
          defaultValue={system.colors.map((token) => `${token.name} ${token.value}`).join("\n")}
          onBlur={(event) => {
            const cores = event.target.value
              .split(/\n+/)
              .map((linha) => linha.trim())
              .filter(Boolean)
              .map((linha) => {
                // "nome #hex" ou só "#hex" — o nome é opcional.
                const match = linha.match(/^(.*?)\s*(#[0-9a-fA-F]{3,8})$/);
                const value = normalizeHex(match?.[2] ?? linha);
                return value ? { name: (match?.[1] || value).trim(), value } : null;
              })
              .filter((token): token is { name: string; value: string } => token !== null);
            commit({ ...system, colors: cores });
          }}
        />
        <small>Uma por linha. O nome é opcional; sem ele, o próprio valor vira o rótulo.</small>
      </label>

      <div className="dsx-row">
        <label className="dsx-field">
          Tipografia
          <input
            defaultValue={system.fonts.join(", ")}
            placeholder="Inter, Georgia"
            onBlur={(event) =>
              commit({
                ...system,
                fonts: event.target.value.split(",").map((f) => f.trim()).filter(Boolean)
              })
            }
          />
        </label>
        <label className="dsx-field">
          Escala (px)
          <input
            defaultValue={system.fontSizes.join(", ")}
            placeholder="12, 14, 16, 24, 32"
            onBlur={(event) => commit({ ...system, fontSizes: parseNumbers(event.target.value) })}
          />
        </label>
        <label className="dsx-field">
          Raios (px)
          <input
            defaultValue={system.radii.join(", ")}
            placeholder="4, 8, 16"
            onBlur={(event) => commit({ ...system, radii: parseNumbers(event.target.value) })}
          />
        </label>
      </div>

      <label className="dsx-field">
        Princípios
        <textarea
          rows={3}
          placeholder="Contraste mínimo AA. Nada de sombra. Espaçamento em múltiplos de 8."
          defaultValue={system.principles}
          onBlur={(event) => commit({ ...system, principles: event.target.value })}
        />
        <small>Entram no prompt de toda geração visual — é o que o modelo não pode esquecer.</small>
      </label>

      <div className="dsx-actions">
        <button className="lg-button" onClick={conferir} disabled={vazio}>
          <CircleCheck size={13} />
          Conferir canvas
        </button>
        <button className="lg-button primary" onClick={corrigir} disabled={vazio}>
          <Wand2 size={13} />
          Corrigir
        </button>
        {note ? <span className="chip">{note}</span> : null}
      </div>

      {violations ? (
        violations.length ? (
          <div className="dsx-violations">
            <p className="dsx-warn">
              <TriangleAlert size={12} />
              {violations.length} item(ns) fora do contrato
            </p>
            {violations.slice(0, 40).map((violation, index) => (
              <button
                className="dsx-violation"
                key={`${violation.nodeId}-${violation.kind}-${index}`}
                onClick={() => onSelect(violation.nodeId)}
                title="Selecionar no canvas"
              >
                <span className={`dsx-kind dsx-kind--${violation.kind}`}>{violation.kind}</span>
                {violation.message}
              </button>
            ))}
            {violations.length > 40 ? <small>+{violations.length - 40} não listados</small> : null}
          </div>
        ) : (
          <p className="dsx-ok">
            <CircleCheck size={12} /> Canvas conforme ao contrato.
          </p>
        )
      ) : null}
    </div>
  );
}
