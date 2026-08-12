/**
 * Colar no composer (Ctrl+V) — imagem, vídeo, GIF e arquivos.
 *
 * O clipboard entrega os arquivos em `clipboardData.files`/`items`. Sem tratar
 * isso, colar um print não fazia nada (o textarea ignora binário).
 * Imagens grandes são redimensionadas antes de virar anexo, para não estourar
 * a janela de contexto do modelo.
 */
export interface PastedFile {
  name: string;
  /** MIME reportado pelo clipboard. */
  type: string;
  file: File;
}

/** true quando o item do clipboard é um arquivo que sabemos anexar. */
export function isAttachable(type: string): boolean {
  return (
    type.startsWith("image/") ||
    type.startsWith("video/") ||
    type.startsWith("audio/") ||
    type === "application/pdf" ||
    type.startsWith("text/") ||
    type === "application/json"
  );
}

/** Nome amigável para conteúdo colado sem nome (print da tela, por exemplo). */
export function pastedName(type: string, index: number): string {
  const ext = type.split("/")[1]?.split("+")[0] ?? "bin";
  const kind = type.startsWith("image/")
    ? "imagem-colada"
    : type.startsWith("video/")
      ? "video-colado"
      : type.startsWith("audio/")
        ? "audio-colado"
        : "arquivo-colado";
  return `${kind}-${index + 1}.${ext}`;
}

/** Extrai os arquivos anexáveis de um evento de colar. */
export function filesFromClipboard(data: DataTransfer | null): PastedFile[] {
  if (!data) return [];
  const found: PastedFile[] = [];
  // `files` cobre o caso comum; `items` pega o print da tela no Windows.
  const direct = Array.from(data.files ?? []);
  for (const file of direct) {
    if (isAttachable(file.type)) found.push({ name: file.name || pastedName(file.type, found.length), type: file.type, file });
  }
  if (!found.length) {
    for (const item of Array.from(data.items ?? [])) {
      if (item.kind !== "file") continue;
      const file = item.getAsFile();
      if (file && isAttachable(file.type)) {
        found.push({ name: file.name || pastedName(file.type, found.length), type: file.type, file });
      }
    }
  }
  return found;
}

/** true quando o clipboard traz texto simples (colar normal, não interceptar). */
export function isPlainTextPaste(data: DataTransfer | null): boolean {
  if (!data) return true;
  return filesFromClipboard(data).length === 0;
}
