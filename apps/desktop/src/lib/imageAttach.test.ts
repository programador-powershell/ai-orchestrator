import { describe, expect, it } from "vitest";
import { fitWithin, isResizableImage, MAX_IMAGE_SIDE } from "./imageAttach";

describe("fitWithin", () => {
  it("reduz mantendo a proporção quando passa do limite", () => {
    const fit = fitWithin(3840, 2160);
    expect(Math.max(fit.width, fit.height)).toBe(MAX_IMAGE_SIDE);
    // 16:9 preservado
    expect(Math.round((fit.width / fit.height) * 100)).toBe(Math.round((3840 / 2160) * 100));
  });

  it("reduz pela altura quando a imagem é vertical", () => {
    const fit = fitWithin(1000, 4000);
    expect(fit.height).toBe(MAX_IMAGE_SIDE);
    expect(fit.width).toBe(400);
  });

  it("NÃO amplia imagem menor que o limite", () => {
    expect(fitWithin(320, 200)).toEqual({ width: 320, height: 200 });
  });

  it("dimensão zero não quebra", () => {
    expect(fitWithin(0, 0)).toEqual({ width: 0, height: 0 });
  });
});

describe("isResizableImage", () => {
  it("aceita raster comum", () => {
    expect(isResizableImage("image/png")).toBe(true);
    expect(isResizableImage("image/jpeg")).toBe(true);
    expect(isResizableImage("image/webp")).toBe(true);
  });

  it("recusa GIF (perderia animação) e SVG (não é raster)", () => {
    expect(isResizableImage("image/gif")).toBe(false);
    expect(isResizableImage("image/svg+xml")).toBe(false);
  });
});
