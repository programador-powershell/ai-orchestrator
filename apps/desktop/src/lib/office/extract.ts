/**
 * Leitura de DOCX/XLSX/PPTX — a ponte para o comando Rust `office_extract`.
 *
 * Devolve o TEXTO real do binário. É só leitura: a IA lê e comenta, mas a
 * edição ao vivo desses formatos depende do motor externo (ver o ADR). No
 * navegador não há backend, então não há extração.
 */

import { invoke } from "@tauri-apps/api/core";

const isTauriHost = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/**
 * Formatos que a extração cobre.
 *
 * `pdf` entra pelo extrator próprio (`src-tauri/src/pdf.rs`), escrito aqui
 * porque não há biblioteca de PDF homologada — a instrução nº 4 manda submeter
 * dependência nova a TI/SI antes de usar.
 */
export const EXTRACTABLE = ["docx", "xlsx", "pptx", "pdf"] as const;
export type ExtractableFormat = (typeof EXTRACTABLE)[number];

export function isExtractable(format: string): format is ExtractableFormat {
  return (EXTRACTABLE as readonly string[]).includes(format);
}

export interface OfficeExtract {
  format: string;
  text: string;
  truncated: boolean;
}

/**
 * Extrai, devolvendo o MOTIVO quando não dá.
 *
 * O erro importa: o extrator de PDF distingue "protegido por senha" de
 * "digitalizado, sem texto extraível", e cada um manda o usuário fazer uma
 * coisa diferente. Engolir isso num `null` transformaria os dois na mesma
 * tela vazia.
 */
export async function extractOffice(
  root: string,
  path: string
): Promise<{ ok: true; data: OfficeExtract } | { ok: false; reason: string }> {
  if (!isTauriHost) {
    return { ok: false, reason: "a leitura de documentos exige o app desktop" };
  }
  try {
    return { ok: true, data: await invoke<OfficeExtract>("office_extract", { root, path }) };
  } catch (cause) {
    return { ok: false, reason: cause instanceof Error ? cause.message : String(cause) };
  }
}
