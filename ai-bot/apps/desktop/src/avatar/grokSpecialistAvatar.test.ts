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

/**
 * A camada v8: a especialidade é a cena ORIGINAL; o corpo é o slime.
 *
 * A regra do pacote é essa divisão — "Especialidade = cena/gesto original;
 * Slime = GrokSlimeCore" —, e é ela que estes testes guardam. O módulo falso
 * expõe `data-grok-body-shape` porque é a esfera que o slime tem de esconder:
 * sem ela, o teste passaria sem ter nada para esconder.
 */
const MODULO_COM_CORPO =
  "data:text/javascript," +
  encodeURIComponent(
    `export const availableAnimations = ["idle","listening","thinking","working","searching","sleeping","drowsy","happy","celebrate","proud","curious","suspicious"];
     export function createAvatar(target) {
       const NS = "http://www.w3.org/2000/svg";
       const svg = document.createElementNS(NS, "svg");
       const corpo = document.createElementNS(NS, "path");
       corpo.setAttribute("d", "M 84 0 A 84 84 0 1 1 -84 0 A 84 84 0 1 1 84 0 Z");
       corpo.setAttribute("data-grok-body-shape", "true");
       svg.appendChild(corpo);
       target.appendChild(svg);
       return { play(){}, pause(){}, stop(){}, destroy(){ svg.remove(); } };
     }`
  );

const quadros = async (quantos: number): Promise<void> => {
  for (let i = 0; i < quantos; i += 1) {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  }
};

const montar = (host: HTMLElement, state: GrokSpecialistState, size: number) =>
  mountGrokSpecialistAvatar(host, { moduleUrl: MODULO_COM_CORPO, specialist: "code", state, size });

describe("animação v8 — slime + cena original", () => {
  it("o corpo do slime deforma quadro a quadro", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const controller = await montar(host, "working", 190);

    const slime = host.querySelector<SVGGElement>("[data-grok-slime-core='true']");
    expect(slime).toBeTruthy();

    const corpo = slime?.querySelector("path");
    await quadros(4);
    const primeiro = corpo?.getAttribute("d") ?? "";
    await quadros(8);
    const segundo = corpo?.getAttribute("d") ?? "";

    // Path fechado de 40 pontos com mola por ponto: longo e sempre em movimento.
    expect(primeiro.length).toBeGreaterThan(200);
    expect(segundo).not.toBe(primeiro);

    controller.destroy();
    host.remove();
  });

  it("esconde a esfera original do módulo", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const controller = await montar(host, "working", 190);
    await quadros(3);

    const redondo = host.querySelector<SVGElement>("[data-grok-body-shape='true']");
    expect(redondo).toBeTruthy();
    expect(redondo?.style.opacity).toBe("0");

    controller.destroy();
    host.remove();
  });

  it("põe a cena profissional NA FRENTE do corpo", async () => {
    // O v8 trouxe o CSS de `.gsa-art-layer` mas não criava a camada: terminal,
    // gráfico e scanner voltavam para dentro do stage único, atrás do slime
    // preto — ou seja, invisíveis. A ordem do DOM é a ordem de pintura.
    const host = document.createElement("div");
    document.body.append(host);
    const controller = await montar(host, "working", 190);
    await quadros(4);

    const root = host.querySelector(".gsa-root");
    const ordem = [...(root?.children ?? [])].map((filho) => filho.getAttribute("class"));
    expect(ordem).toEqual(["gsa-stage", "gsa-avatar", "gsa-art-layer"]);

    // E o terminal do especialista de Código está mesmo na camada da frente.
    expect(host.querySelectorAll(".gsa-art-layer rect, .gsa-art-layer line").length).toBeGreaterThan(0);

    controller.destroy();
    host.remove();
  });

  it("num avatar de lista mantém o slime e omite a cena", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const controller = await montar(host, "working", 26);
    await quadros(4);

    expect(host.querySelectorAll(".gsa-art-layer rect, .gsa-art-layer line").length).toBe(0);

    const corpo = host.querySelector<SVGGElement>("[data-grok-slime-core='true']")?.querySelector("path");
    expect((corpo?.getAttribute("d") ?? "").length).toBeGreaterThan(200);

    controller.destroy();
    host.remove();
  });
});
