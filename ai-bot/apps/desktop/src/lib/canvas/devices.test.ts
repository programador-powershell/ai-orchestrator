import { describe, expect, it } from "vitest";
import { addNode, createDoc, type CanvasDoc, type CanvasNode } from "./canvasDoc";
import { applyDevicePreset, DEVICES } from "./devices";

const rect = (id: string): CanvasNode => ({ id, type: "rect", x: 0, y: 0, w: 100, h: 50, fill: "#ff0000" });

const preset = (id: "desktop" | "tablet" | "mobile") => DEVICES.find((device) => device.id === id)!;

describe("DEVICES (dados)", () => {
  it("traz os três presets nas medidas consagradas", () => {
    expect(DEVICES.map((device) => device.id)).toEqual(["desktop", "tablet", "mobile"]);
    expect(preset("desktop")).toMatchObject({ w: 1440, h: 1024 });
    expect(preset("tablet")).toMatchObject({ w: 768, h: 1024 });
    expect(preset("mobile")).toMatchObject({ w: 375, h: 812 });
  });

  it("todo preset tem rótulo para o segmented da barra", () => {
    for (const device of DEVICES) expect(device.label.length).toBeGreaterThan(0);
  });
});

describe("applyDevicePreset", () => {
  it("redimensiona o frame selecionado", () => {
    const doc = createDoc(); // frame-1 480x320
    const out = applyDevicePreset(doc, "frame-1", preset("mobile"));
    expect(out.selectedId).toBe("frame-1");
    expect(out.doc.nodes.find((n) => n.id === "frame-1")).toMatchObject({ w: 375, h: 812 });
  });

  /** Seleção que não é frame não pode virar preset — cai no 1º frame do doc. */
  it("seleção em nó que não é frame cai no primeiro frame", () => {
    const doc = addNode(createDoc(), rect("rect-1"));
    const out = applyDevicePreset(doc, "rect-1", preset("tablet"));
    expect(out.selectedId).toBe("frame-1");
    expect(out.doc.nodes.find((n) => n.id === "frame-1")).toMatchObject({ w: 768, h: 1024 });
    expect(out.doc.nodes.find((n) => n.id === "rect-1")).toMatchObject({ w: 100, h: 50 });
  });

  it("sem seleção usa o primeiro frame", () => {
    const out = applyDevicePreset(createDoc(), null, preset("desktop"));
    expect(out.selectedId).toBe("frame-1");
    expect(out.doc.nodes.find((n) => n.id === "frame-1")).toMatchObject({ w: 1440, h: 1024 });
  });

  /** O botão precisa SEMPRE produzir efeito visível: sem frame, nasce um. */
  it("doc sem frame ganha um frame novo com o tamanho do preset", () => {
    const doc: CanvasDoc = { name: "t", nodes: [rect("rect-1")] };
    const out = applyDevicePreset(doc, null, preset("mobile"));
    const frame = out.doc.nodes.find((n) => n.id === out.selectedId);
    expect(frame).toMatchObject({ type: "frame", x: 40, y: 40, w: 375, h: 812 });
    expect(out.doc.nodes).toHaveLength(2);
  });

  it("não muta o documento original", () => {
    const doc = createDoc();
    applyDevicePreset(doc, "frame-1", preset("mobile"));
    expect(doc.nodes.find((n) => n.id === "frame-1")).toMatchObject({ w: 480, h: 320 });
  });
});
