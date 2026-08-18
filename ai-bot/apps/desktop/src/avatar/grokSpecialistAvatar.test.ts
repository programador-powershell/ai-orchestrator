/**
 * Contrato do motor profissional v3: estado do runtime
 * vira estado visual, especialista escolhe animação DO MÓDULO carregado por
 * URL, e o controller monta/desmonta sem vazar. O módulo de teste entra por
 * `data:` URL — o mesmo mecanismo do export real do Lab, sem arquivo em disco.
 */

import { describe, expect, it } from "vitest";

import {
  PROFESSIONAL_GROK_BEHAVIOR_MAP,
  professionalVisualStateFromRuntime,
  mountProfessionalGrokAvatar,
  type Specialist as GrokSpecialist,
  type SpecialistState as GrokSpecialistState
} from "./grok_professional_avatar_v3";
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

describe("professionalVisualStateFromRuntime", () => {
  it("concluído vence tudo, dono vem depois", () => {
    expect(professionalVisualStateFromRuntime({ completed: true, isOwner: true, status: "RUNNING" })).toBe("completed");
    expect(professionalVisualStateFromRuntime({ isOwner: true, status: "RUNNING" })).toBe("owner");
  });

  it("traduz os status de execução e de fila", () => {
    expect(professionalVisualStateFromRuntime({ status: "RUNNING" })).toBe("working");
    expect(professionalVisualStateFromRuntime({ status: "verifying" })).toBe("working");
    expect(professionalVisualStateFromRuntime({ status: "WAITING_APPROVAL" })).toBe("waiting");
    expect(professionalVisualStateFromRuntime({ status: "QUEUED" })).toBe("waiting");
    expect(professionalVisualStateFromRuntime({ status: "COMPLETED" })).toBe("completed");
  });

  it("status desconhecido ou vazio é presença ativa", () => {
    expect(professionalVisualStateFromRuntime({})).toBe("active");
    expect(professionalVisualStateFromRuntime({ status: "qualquer-coisa" })).toBe("active");
  });
});

describe("catálogo do wrapper", () => {
  it("cobre os oito especialistas nos cinco estados", () => {
    for (const specialist of ESPECIALISTAS) {
      for (const state of ESTADOS) {
        expect(PROFESSIONAL_GROK_BEHAVIOR_MAP[specialist][state].length, `${specialist}/${state}`).toBeGreaterThan(0);
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

describe("mountProfessionalGrokAvatar", () => {
  it("monta, toca a animação do estado e desmonta sem deixar nada", async () => {
    globalThis.__gsaPlays = [];
    const host = document.createElement("div");
    document.body.append(host);

    const controller = await mountProfessionalGrokAvatar(host, {
      moduleUrl: MODULO_FAKE,
      specialist: "code",
      state: "working"
    });

    const root = host.querySelector<HTMLElement>(".gmv7-root");
    expect(root).toBeTruthy();
    expect(root?.dataset.state).toBe("working");
    // O v7 passou a rotular em português, que é a língua da interface.
    expect(root?.getAttribute("aria-label")).toContain("Código");
    expect(globalThis.__gsaPlays.at(-1)).toBe("working");

    controller.setState("waiting");
    expect(root?.dataset.state).toBe("waiting");
    expect(globalThis.__gsaPlays.at(-1)).toBe("sleeping");

    controller.setState("completed");
    expect(globalThis.__gsaPlays.at(-1)).toBe("celebrate");

    controller.setSpecialist("data");
    expect(root?.dataset.specialist).toBe("data");

    controller.destroy();
    expect(host.querySelector(".gmv7-root")).toBeNull();
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
 * A camada v7: o corpo é MASSA, não desenho.
 *
 * Corpo = elipse preta; membros = cadeias de círculos pretos; todos passando
 * pelo mesmo filtro goo, que os funde. A leitura que a v6 ainda dava — "uma
 * forma preta com o desenho da profissão por cima" — some porque os membros
 * nascem da própria massa.
 *
 * O módulo falso expõe `data-grok-body-shape`, como o stand-in real: é ele que
 * o motor precisa esconder. Sem isso o teste do "esconde o redondo" passaria
 * sem ter nada para esconder.
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
  mountProfessionalGrokAvatar(host, { moduleUrl: MODULO_COM_CORPO, specialist: "code", state, size });

describe("animação v7 — metaball", () => {
  it("os membros são massa fundida, não traço por cima", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const controller = await montar(host, "working", 190);
    await quadros(6);

    const goo = host.querySelector<SVGGElement>("[data-grok-goo=true]");
    expect(goo).toBeTruthy();

    // O filtro é o que funde corpo e membros numa massa só. Sem ele o desenho
    // vira bolinhas soltas, que é exatamente a leitura que a v7 veio corrigir.
    expect(goo?.getAttribute("filter") ?? "").toContain("url(#");

    // Corpo + cadeias de círculos, todos DENTRO do mesmo grupo filtrado.
    expect(goo?.querySelectorAll("ellipse").length ?? 0).toBeGreaterThanOrEqual(1);
    expect(goo?.querySelectorAll("circle").length ?? 0).toBeGreaterThan(3);

    controller.destroy();
    host.remove();
  });

  it("a massa se move com atraso e elasticidade", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const controller = await montar(host, "working", 190);

    const goo = host.querySelector<SVGGElement>("[data-grok-goo=true]");
    const amostra = () =>
      [...(goo?.querySelectorAll("circle") ?? [])]
        .map((c) => `${c.getAttribute("cx")},${c.getAttribute("cy")},${c.getAttribute("r")}`)
        .join("|");

    await quadros(5);
    const antes = amostra();
    await quadros(8);
    const depois = amostra();

    // Física de mola: as cadeias perseguem o alvo, então mudam entre quadros.
    expect(antes.length).toBeGreaterThan(0);
    expect(depois).not.toBe(antes);

    controller.destroy();
    host.remove();
  });

  it("esconde o corpo redondo que veio do módulo", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const controller = await montar(host, "working", 190);
    await quadros(3);

    const redondo = host.querySelector<SVGElement>("[data-grok-body-shape=true]");
    expect(redondo).toBeTruthy();
    expect(redondo?.style.opacity).toBe("0");

    controller.destroy();
    host.remove();
  });

  it("empilha massa, rosto e cena nessa ordem", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const controller = await montar(host, "working", 190);

    const root = host.querySelector(".gmv7-root");
    const ordem = [...(root?.children ?? [])].map((filho) => filho.getAttribute("class"));

    // A ordem do DOM É a ordem de pintura. Os olhos ficam ACIMA do metaball, e
    // a cena acima de tudo — senão o terminal some atrás da massa.
    expect(ordem).toEqual(["gmv7-body", "gmv7-avatar", "gmv7-art"]);

    controller.destroy();
    host.remove();
  });
});
