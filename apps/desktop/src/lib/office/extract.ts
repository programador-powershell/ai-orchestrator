/**
 * Leitura de DOCX/XLSX/PPTX — a ponte para o comando Rust `office_extract`.
 *
 * Devolve o TEXTO real do binário. É só leitura: a IA lê e comenta, mas a
 * edição ao vivo desses formatos depende do motor externo (ver o ADR). No
 * navegador não há backend, então não há extração.
 */

import { invoke } from "@tauri-apps/api/core";

const isTauriHost = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Formatos que a extração cobre — OOXML. PDF ainda não (parser à parte). */
export const EXTRACTABLE = ["docx", "xlsx", "pptx"] as const;
export type ExtractableFormat = (typeof EXTRACTABLE)[number];

export function isExtractable(format: string): format is ExtractableFormat {
  return (EXTRACTABLE as readonly string[]).includes(format);
}

export interface OfficeExtract {
  format: string;
  text: string;
  truncated: boolean;
}

export async function extractOffice(root: string, path: string): Promise<OfficeExtract | null> {
  if (!isTauriHost) return null;
  try {
    return await invoke<OfficeExtract>("office_extract", { root, path });
  } catch {
    // Arquivo corrompido / não é OOXML válido — o chamador decide a mensagem.
    return null;
  }
}
