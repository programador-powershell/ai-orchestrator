import { describe, expect, it } from "vitest";
import { buildFfmpegExport, type ExportClip, type ExportMedia } from "./videoExport";

const media: ExportMedia[] = [
  { id: "m1", name: "intro.mp4" },
  { id: "m2", name: "corpo.mp4" }
];

describe("buildFfmpegExport", () => {
  it("um clipe com áudio: trim + concat + os dois maps", () => {
    const plan = buildFfmpegExport([{ mediaId: "m1", start: 0, end: 5 }], media);
    expect(plan.ok).toBe(true);
    expect(plan.command).toContain('-i "intro.mp4"');
    expect(plan.command).toContain("trim=start=0.00:end=5.00");
    expect(plan.command).toContain("atrim=start=0.00:end=5.00");
    expect(plan.command).toContain("concat=n=1:v=1:a=1[vout][aout]");
    expect(plan.command).toContain('-map "[vout]" -map "[aout]"');
    expect(plan.command).toContain('"corte-final.mp4"');
    expect(plan.command).toContain("ffmpeg -y");
  });

  it("sem áudio: nenhum atrim, concat só de vídeo, um map só", () => {
    const plan = buildFfmpegExport([{ mediaId: "m1", start: 0, end: 5 }], media, { withAudio: false });
    expect(plan.command).not.toContain("atrim");
    expect(plan.command).not.toContain("[aout]");
    expect(plan.command).toContain("concat=n=1:v=1:a=0[vout]");
    expect(plan.command).toContain('-map "[vout]"');
  });

  it("mídia usada duas vezes vira um input só, indexado", () => {
    const clips: ExportClip[] = [
      { mediaId: "m1", start: 0, end: 2 },
      { mediaId: "m1", start: 5, end: 8 }
    ];
    const plan = buildFfmpegExport(clips, media);
    // um único -i, dois trims sobre [0:v]
    expect(plan.command.match(/-i "/g)).toHaveLength(1);
    expect(plan.command).toContain("[0:v]trim=start=0.00:end=2.00");
    expect(plan.command).toContain("[0:v]trim=start=5.00:end=8.00");
    expect(plan.command).toContain("concat=n=2");
  });

  it("dois inputs distintos ganham índices 0 e 1", () => {
    const clips: ExportClip[] = [
      { mediaId: "m1", start: 0, end: 2 },
      { mediaId: "m2", start: 0, end: 3 }
    ];
    const plan = buildFfmpegExport(clips, media);
    expect(plan.command).toContain('-i "intro.mp4" -i "corpo.mp4"');
    expect(plan.command).toContain("[1:v]trim");
  });

  it("nome de saída customizado", () => {
    expect(buildFfmpegExport([{ mediaId: "m1", start: 0, end: 1 }], media, { output: "aula.mp4" }).command).toContain(
      '"aula.mp4"'
    );
  });

  it("recusa timeline vazia", () => {
    const plan = buildFfmpegExport([], media);
    expect(plan.ok).toBe(false);
    expect(plan.reason).toContain("clipe");
  });

  it("recusa clipe sem duração positiva", () => {
    expect(buildFfmpegExport([{ mediaId: "m1", start: 5, end: 5 }], media).ok).toBe(false);
    expect(buildFfmpegExport([{ mediaId: "m1", start: 5, end: 2 }], media).ok).toBe(false);
  });

  it("recusa clipe apontando para mídia ausente", () => {
    const plan = buildFfmpegExport([{ mediaId: "sumiu", start: 0, end: 1 }], media);
    expect(plan.ok).toBe(false);
    expect(plan.reason).toContain("mídia");
  });

  it("RECUSA nome de arquivo com aspas — evita escapar do comando", () => {
    const perigoso: ExportMedia[] = [{ id: "m1", name: 'a" & del *.mp4' }];
    const plan = buildFfmpegExport([{ mediaId: "m1", start: 0, end: 1 }], perigoso);
    expect(plan.ok).toBe(false);
    expect(plan.reason).toContain("inseguro");
  });

  it("recusa nome de saída com aspas ou vazio", () => {
    expect(buildFfmpegExport([{ mediaId: "m1", start: 0, end: 1 }], media, { output: 'x".mp4' }).ok).toBe(false);
  });
});
