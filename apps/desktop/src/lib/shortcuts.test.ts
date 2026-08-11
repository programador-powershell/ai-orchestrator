import { describe, expect, it } from "vitest";
import { isSettingsShortcut, modeForDigitKey } from "./shortcuts";

const MODES = ["chat", "code", "data"] as const;

describe("modeForDigitKey", () => {
  it("mapeia dígito 1..n para o modo visível correspondente", () => {
    expect(modeForDigitKey("1", MODES)).toBe("chat");
    expect(modeForDigitKey("3", MODES)).toBe("data");
  });

  it("retorna null fora do intervalo ou para tecla não numérica", () => {
    expect(modeForDigitKey("4", MODES)).toBeNull();
    expect(modeForDigitKey("0", MODES)).toBeNull();
    expect(modeForDigitKey("a", MODES)).toBeNull();
    expect(modeForDigitKey("", MODES)).toBeNull();
  });

  it("retorna null para lista vazia", () => {
    expect(modeForDigitKey("1", [])).toBeNull();
  });
});

describe("isSettingsShortcut", () => {
  it("aceita Ctrl+, e Cmd+,", () => {
    expect(isSettingsShortcut({ ctrlKey: true, metaKey: false, key: "," })).toBe(true);
    expect(isSettingsShortcut({ ctrlKey: false, metaKey: true, key: "," })).toBe(true);
  });

  it("rejeita vírgula sem modificador e modificador com outra tecla", () => {
    expect(isSettingsShortcut({ ctrlKey: false, metaKey: false, key: "," })).toBe(false);
    expect(isSettingsShortcut({ ctrlKey: true, metaKey: false, key: "." })).toBe(false);
  });
});
