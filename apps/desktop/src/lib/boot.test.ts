import { beforeEach, describe, expect, it, vi } from "vitest";
import { __resetBootForTests, runBootOnce } from "./boot";

describe("runBootOnce", () => {
  beforeEach(() => __resetBootForTests());

  it("executa o callback na primeira chamada", () => {
    const boot = vi.fn();
    expect(runBootOnce(boot)).toBe(true);
    expect(boot).toHaveBeenCalledTimes(1);
  });

  it("ignora chamadas seguintes (StrictMode roda efeitos 2x em dev)", () => {
    const boot = vi.fn();
    runBootOnce(boot);
    expect(runBootOnce(boot)).toBe(false);
    expect(boot).toHaveBeenCalledTimes(1);
  });

  it("não repete o boot mesmo quando o callback lança", () => {
    const failing = vi.fn(() => {
      throw new Error("boot falhou");
    });
    expect(() => runBootOnce(failing)).toThrow("boot falhou");
    const second = vi.fn();
    expect(runBootOnce(second)).toBe(false);
    expect(second).not.toHaveBeenCalled();
  });
});
