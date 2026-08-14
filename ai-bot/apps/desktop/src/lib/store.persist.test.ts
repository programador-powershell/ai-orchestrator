/**
 * O store não pode gravar no disco a cada `set`.
 *
 * Este teste é sobre a LIGAÇÃO, não sobre o armazenamento em si (esse tem os
 * seus em `persistStorage.test.ts`): o `persist` do zustand grava a cada
 * `setState` sem comparar nada, e este store recebe um `set` por token de
 * resposta. Sem o `storage` coalescido plugado nas opções, um turno de 800
 * tokens vira 800 `JSON.stringify` mais 800 escritas síncronas na thread que
 * desenha — e o `partialize` não salva, porque o custo é por `set`.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { preferenceStorage } from "./persistStorage";
import { useApp } from "./store";

const KEY = "aibot.v1";

describe("persistência do store", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.removeItem(KEY);
  });

  it("não toca o localStorage a cada `set` — a rajada vira uma gravação só", () => {
    const written = vi.spyOn(Storage.prototype, "setItem");

    // A rajada de um turno: cada delta do gateway é um `set` no store.
    for (let token = 1; token <= 200; token += 1) {
      useApp.setState({ thinking: `escrevendo ${token}`, busy: true });
    }

    // Nada foi ao disco: nem uma escrita para 200 mudanças que sequer são
    // persistidas.
    expect(written).not.toHaveBeenCalled();

    // E o que é preferência de verdade continua chegando lá — uma vez.
    useApp.setState({ theme: "dark" });
    preferenceStorage().flush();
    expect(written).toHaveBeenCalledTimes(1);

    const payload = JSON.parse(localStorage.getItem(KEY) ?? "{}") as {
      state?: Record<string, unknown>;
    };
    // O `partialize` continua valendo: conversa e sessões não vão para o disco.
    expect(Object.keys(payload.state ?? {}).sort()).toEqual(["avatars", "railOpen", "theme"]);
    expect(payload.state?.theme).toBe("dark");
  });

  it("não regrava preferência que não mudou", () => {
    useApp.setState({ theme: "light" });
    preferenceStorage().flush();

    const written = vi.spyOn(Storage.prototype, "setItem");
    useApp.setState({ theme: "light" });
    preferenceStorage().flush();
    expect(written).not.toHaveBeenCalled();
  });
});
