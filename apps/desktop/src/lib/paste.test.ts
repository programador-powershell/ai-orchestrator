import { describe, expect, it } from "vitest";
import { filesFromClipboard, isAttachable, isPlainTextPaste, pastedName } from "./paste";

function fakeFile(name: string, type: string): File {
  return new File(["conteudo"], name, { type });
}

/** DataTransfer mínimo — o jsdom do Node não implementa o real. */
function clipboard(files: File[], asItems = false): DataTransfer {
  const items = files.map((file) => ({ kind: "file" as const, type: file.type, getAsFile: () => file }));
  return {
    files: asItems ? [] : files,
    items: asItems ? items : []
  } as unknown as DataTransfer;
}

describe("isAttachable", () => {
  it("aceita imagem, vídeo, áudio, pdf e texto", () => {
    expect(isAttachable("image/png")).toBe(true);
    expect(isAttachable("image/gif")).toBe(true);
    expect(isAttachable("video/mp4")).toBe(true);
    expect(isAttachable("application/pdf")).toBe(true);
    expect(isAttachable("text/markdown")).toBe(true);
  });

  it("recusa binário desconhecido", () => {
    expect(isAttachable("application/x-msdownload")).toBe(false);
  });
});

describe("pastedName", () => {
  it("nomeia print de tela sem nome", () => {
    expect(pastedName("image/png", 0)).toBe("imagem-colada-1.png");
    expect(pastedName("video/mp4", 1)).toBe("video-colado-2.mp4");
  });
});

describe("filesFromClipboard", () => {
  it("extrai de clipboardData.files", () => {
    const found = filesFromClipboard(clipboard([fakeFile("foto.png", "image/png")]));
    expect(found).toHaveLength(1);
    expect(found[0].name).toBe("foto.png");
  });

  it("cai para items quando files vem vazio (print no Windows)", () => {
    const found = filesFromClipboard(clipboard([fakeFile("", "image/png")], true));
    expect(found).toHaveLength(1);
    expect(found[0].name).toBe("imagem-colada-1.png");
  });

  it("ignora tipo não anexável", () => {
    expect(filesFromClipboard(clipboard([fakeFile("v.exe", "application/x-msdownload")]))).toHaveLength(0);
  });

  it("clipboard nulo não quebra", () => {
    expect(filesFromClipboard(null)).toEqual([]);
  });
});

describe("isPlainTextPaste", () => {
  it("texto puro não é interceptado", () => {
    expect(isPlainTextPaste(clipboard([]))).toBe(true);
  });

  it("colar com arquivo é interceptado", () => {
    expect(isPlainTextPaste(clipboard([fakeFile("a.png", "image/png")]))).toBe(false);
  });
});
