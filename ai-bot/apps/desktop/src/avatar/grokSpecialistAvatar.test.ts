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
 * A camada v4: a SILHUETA deforma, as camadas ficam na ordem certa e a cena só
 * entra em quem tem tamanho para mostrá-la.
 *
 * O módulo falso daqui expõe `data-grok-body-shape`, como o stand-in real —
 * sem isso o motor cai no ramo de compatibilidade (que ainda usa scale no
 * hospedeiro) e o teste passaria sem exercitar a silhueta, que é justamente o
 * que mudou.
 */
const MODULO_COM_SILHUETA =
  "data:text/javascript," +
  encodeURIComponent(
    `export const availableAnimations = ["idle","listening","thinking","working","searching","sleeping","drowsy","happy","celebrate","proud","curious","suspicious"];
     export function createAvatar(target) {
       const NS = "http://www.w3.org/2000/svg";
       const svg = document.createElementNS(NS, "svg");
       svg.setAttribute("viewBox", "-100 -100 200 200");
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

describe("animação v4", () => {
  it("deforma a SILHUETA, não a caixa do rosto", async () => {
    const host = document.createElement("div");
    document.body.append(host);

    const controller = await mountProfessionalGrokAvatar(host, {
      moduleUrl: MODULO_COM_SILHUETA,
      specialist: "code",
      state: "working",
      size: 150
    });

    const corpo = host.querySelector<SVGPathElement>("[data-grok-body-shape=true]");
    expect(corpo).toBeTruthy();

    await quadros(4);
    const primeiro = corpo?.getAttribute("d") ?? "";
    await quadros(6);
    const segundo = corpo?.getAttribute("d") ?? "";

    // O corpo deixou de ser um círculo escalado: o próprio `d` muda por quadro.
    expect(primeiro).not.toBe("M 84 0 A 84 84 0 1 1 -84 0 A 84 84 0 1 1 84 0 Z");
    expect(segundo).not.toBe(primeiro);

    // E o rosto só INCLINA — se voltasse a escalar, os olhos viravam elipses.
    const rosto = host.querySelector<HTMLElement>(".gsa-avatar");
    expect(rosto?.style.transform ?? "").not.toContain("scale(");

    controller.destroy();
    host.remove();
  });

  it("empilha as camadas na ordem: braços atrás, corpo no meio, cena na frente", async () => {
    const host = document.createElement("div");
    document.body.append(host);

    const controller = await mountProfessionalGrokAvatar(host, {
      moduleUrl: MODULO_COM_SILHUETA,
      specialist: "code",
      state: "working",
      size: 150
    });

    const root = host.querySelector(".gsa-root");
    const ordem = [...(root?.children ?? [])].map((filho) => filho.getAttribute("class"));

    // A ordem do DOM É a ordem de pintura. Com a cena atrás do corpo, o terminal
    // ficava escondido pela bolinha preta — que era o defeito do v3.
    expect(ordem).toEqual(["gsa-stage", "gsa-avatar", "gsa-art-layer"]);

    await quadros(4);
    // Braços na traseira; terminal, gráfico e sliders na frontal.
    expect(host.querySelectorAll(".gsa-stage .gsa-blob-limb").length).toBe(2);
    expect(host.querySelectorAll(".gsa-art-layer rect, .gsa-art-layer line").length).toBeGreaterThan(0);

    controller.destroy();
    host.remove();
  });

  it("NÃO desenha a cena num avatar de lista, onde ela seria borrão", async () => {
    // A lista de tarefas usa 26 px. Um terminal de 116 unidades num viewBox de
    // 200 vira três pixels — e reconstruí-lo a cada quadro, por avatar, custaria
    // dezenas de nós SVG por segundo para não mostrar nada.
    const host = document.createElement("div");
    document.body.append(host);

    const controller = await mountProfessionalGrokAvatar(host, {
      moduleUrl: MODULO_COM_SILHUETA,
      specialist: "code",
      state: "working",
      size: 26
    });

    await quadros(4);
    expect(host.querySelectorAll(".gsa-art-layer rect, .gsa-art-layer line, .gsa-art-layer text").length).toBe(0);

    // Mesmo pequeno a SILHUETA continua viva: é ela que se lê nesse tamanho.
    const corpo = host.querySelector<SVGPathElement>("[data-grok-body-shape=true]");
    expect(corpo?.getAttribute("d")).not.toBe("M 84 0 A 84 84 0 1 1 -84 0 A 84 84 0 1 1 84 0 Z");

    controller.destroy();
    host.remove();
  });
});
