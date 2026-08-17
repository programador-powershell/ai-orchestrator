/**
 * O contrato do wrapper v2 (arquivo do usuário, verbatim): estado do runtime
 * vira estado visual, especialista escolhe animação DO MÓDULO carregado por
 * URL, e o controller monta/desmonta sem vazar. O módulo de teste entra por
 * `data:` URL — o mesmo mecanismo do export real do Lab, sem arquivo em disco.
 */

import { describe, expect, it } from "vitest";

import {
  GROK_SPECIALIST_BEHAVIOR_MAP,
  grokVisualStateFromRuntime,
  mountGrokSpecialistAvatar,
  type GrokSpecialist,
  type GrokSpecialistState
} from "./grokSpecialistAvatar";
import { GROK_STATE_LABELS, grokSpecialistOf } from "./GrokAvatar";

const ESPECIALISTAS: GrokSpecialist[] = ["chat", "code", "data", "design", "agent", "flow", "tuning", "security"];
const ESTADOS: GrokSpecialistState[] = ["active", "owner", "working", "waiting", "completed"];

declare global {
  var __gsaPlays: string[] | undefined;
}

const MODULO_FAKE =
  "data:text/javascript," +
  encodeURIComponent(
    `export const availableAnimations = ["idle","listening","thinking","working","searching","sleeping","drowsy","happy","celebrate","proud","curious","suspicious"];
     export function createAvatar(target) {
       const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
       target.appendChild(svg);
       globalThis.__gsaPlays = globalThis.__gsaPlays ?? [];
       return {
         play(nome) { globalThis.__gsaPlays.push(nome); },
         pause() {},
         stop() {},
         destroy() { svg.remove(); }
       };
     }`
  );

describe("grokVisualStateFromRuntime", () => {
  it("concluído vence tudo, dono vem depois", () => {
    expect(grokVisualStateFromRuntime({ completed: true, isOwner: true, status: "RUNNING" })).toBe("completed");
    expect(grokVisualStateFromRuntime({ isOwner: true, status: "RUNNING" })).toBe("owner");
  });

  it("traduz os status de execução e de fila", () => {
    expect(grokVisualStateFromRuntime({ status: "RUNNING" })).toBe("working");
    expect(grokVisualStateFromRuntime({ status: "verifying" })).toBe("working");
    expect(grokVisualStateFromRuntime({ status: "WAITING_APPROVAL" })).toBe("waiting");
    expect(grokVisualStateFromRuntime({ status: "QUEUED" })).toBe("waiting");
    expect(grokVisualStateFromRuntime({ status: "COMPLETED" })).toBe("completed");
  });

  it("status desconhecido ou vazio é presença ativa", () => {
    expect(grokVisualStateFromRuntime({})).toBe("active");
    expect(grokVisualStateFromRuntime({ status: "qualquer-coisa" })).toBe("active");
  });
});

describe("catálogo do wrapper", () => {
  it("cobre os oito especialistas nos cinco estados", () => {
    for (const specialist of ESPECIALISTAS) {
      for (const state of ESTADOS) {
        expect(GROK_SPECIALIST_BEHAVIOR_MAP[specialist][state].length, `${specialist}/${state}`).toBeGreaterThan(0);
      }
      expect(GROK_STATE_LABELS.owner.length).toBeGreaterThan(0);
    }
  });

  it("aproxima os ids do AI-BOT que o wrapper não conhece", () => {
    expect(grokSpecialistOf("code")).toBe("code");
    expect(grokSpecialistOf("fluxo")).toBe("flow");
    expect(grokSpecialistOf("tune")).toBe("tuning");
    expect(grokSpecialistOf("office")).toBe("chat");
    expect(grokSpecialistOf("work")).toBe("flow");
    expect(grokSpecialistOf("master")).toBe("agent");
    expect(grokSpecialistOf("desconhecido")).toBe("agent");
  });
});

describe("mountGrokSpecialistAvatar", () => {
  it("monta, toca a animação do estado e desmonta sem deixar nada", async () => {
    globalThis.__gsaPlays = [];
    const host = document.createElement("div");
    document.body.append(host);

    const controller = await mountGrokSpecialistAvatar(host, {
      moduleUrl: MODULO_FAKE,
      specialist: "code",
      state: "working"
    });

    const root = host.querySelector<HTMLElement>(".gsa-root");
    expect(root).toBeTruthy();
    expect(root?.dataset.state).toBe("working");
    expect(root?.getAttribute("aria-label")).toContain("Code");
    expect(globalThis.__gsaPlays.at(-1)).toBe("working");

    controller.setState("waiting");
    expect(root?.dataset.state).toBe("waiting");
    expect(globalThis.__gsaPlays.at(-1)).toBe("sleeping");

    controller.setState("completed");
    expect(globalThis.__gsaPlays.at(-1)).toBe("celebrate");

    controller.setSpecialist("data");
    expect(root?.dataset.specialist).toBe("data");

    controller.destroy();
    expect(host.querySelector(".gsa-root")).toBeNull();
    host.remove();
  });
});

describe("stand-in público", () => {
  it("responde pela interface do export do Lab", async () => {
    // @ts-expect-error — o stand-in é JS puro sem declaração, de propósito: é o
    // arquivo que o export real do Lab substitui, e um .d.ts mentiria sobre ele.
    const standIn = (await import("../../public/avatars/grok-avatar.js")) as {
      availableAnimations: readonly string[];
      createAvatar(target: Element): { play(n?: string): void; pause(): void; stop(): void; destroy(): void };
    };
    expect(standIn.availableAnimations).toContain("working");
    expect(standIn.availableAnimations).toContain("celebrate");
    expect(standIn.availableAnimations.length).toBeGreaterThanOrEqual(13);

    const host = document.createElement("div");
    document.body.append(host);
    const instancia = standIn.createAvatar(host);
    expect(host.querySelector("svg")).toBeTruthy();
    instancia.play("happy");
    instancia.pause();
    instancia.destroy();
    expect(host.querySelector("svg")).toBeNull();
    host.remove();
  });
});
