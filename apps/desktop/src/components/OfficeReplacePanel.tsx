"use client";

/**
 * Substituir texto dentro do BINÁRIO (DOCX/PPTX), sem motor externo.
 *
 * Antes esta aba só lia OOXML — a edição dependia do Collabora (ver
 * `docs/adr-office-motor-wopi.md`), que exige contêiner e homologação. O
 * `office_replace_text` no Rust reescreve o arquivo de verdade preservando
 * formatação, estilos, numeração e relações.
 *
 * Por que o painel avisa antes e mostra o resultado depois: a operação **é
 * destrutiva** — reescreve o arquivo no lugar. O usuário precisa saber quantas
 * ocorrências mudaram e em quais partes (corpo, cabeçalho, rodapé), senão um
 * "substituir tudo" que pegou o rodapé passa despercebido.
 */

import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { LoaderCircle, Replace, TriangleAlert } from "lucide-react";

interface EditOutcome {
  replaced: number;
  parts: string[];
}

/** Nome legível da parte do pacote — "word/header1.xml" não diz nada. */
function parteLegivel(nome: string): string {
  if (nome === "word/document.xml") return "corpo";
  if (nome.startsWith("word/header")) return "cabeçalho";
  if (nome.startsWith("word/footer")) return "rodapé";
  if (nome === "word/footnotes.xml") return "notas de rodapé";
  if (nome === "word/endnotes.xml") return "notas de fim";
  if (nome.startsWith("ppt/slides/slide")) {
    return `slide ${nome.replace(/\D+/g, "") || "?"}`;
  }
  return nome;
}

export function OfficeReplacePanel({
  root,
  path,
  onDone
}: {
  root: string;
  path: string;
  onDone?: () => void;
}) {
  const [needle, setNeedle] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<EditOutcome | null>(null);
  const [error, setError] = useState("");

  async function aplicar() {
    if (busy || !needle.trim()) return;
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const outcome = await invoke<EditOutcome>("office_replace_text", {
        root,
        path,
        needle,
        value
      });
      setResult(outcome);
      // Só recarrega se algo mudou — releitura à toa piscaria a tela.
      if (outcome.replaced > 0) onDone?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="offx-replace">
      <div className="offx-replace-row">
        <input
          value={needle}
          onChange={(event) => setNeedle(event.target.value)}
          placeholder="texto a localizar"
          spellCheck={false}
        />
        <input
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="substituir por (vazio = apagar)"
          spellCheck={false}
        />
        <button className="lg-button primary" onClick={() => void aplicar()} disabled={busy || !needle.trim()}>
          {busy ? <LoaderCircle size={13} className="spin" /> : <Replace size={13} />}
          {busy ? "Gravando…" : "Substituir"}
        </button>
      </div>

      {/* A operação reescreve o arquivo no lugar — dizer isso antes, não depois. */}
      <small className="offx-replace-hint">
        Reescreve o arquivo no lugar, preservando formatação e estilos. Trechos sob controle de alterações e códigos de
        campo são <strong>ignorados</strong> de propósito.
      </small>

      {error ? (
        <p className="offx-replace-error">
          <TriangleAlert size={12} /> {error}
        </p>
      ) : null}

      {result ? (
        result.replaced > 0 ? (
          <p className="offx-replace-ok">
            {result.replaced} ocorrência(s) substituída(s) em {result.parts.map(parteLegivel).join(", ")}.
          </p>
        ) : (
          <p className="offx-replace-hint">
            Nenhuma ocorrência encontrada — o arquivo <strong>não</strong> foi alterado.
          </p>
        )
      ) : null}
    </div>
  );
}
