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

    const root = host.querySelector<HTMLElement>(".gpv6-root");
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
    expect(host.querySelector(".gpv6-root")).toBeNull();
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
 * A camada v5: o motor DESENHA a própria silhueta e esconde o corpo redondo que
 * vem do módulo.
 *
 * O módulo falso daqui expõe `data-grok-body-shape`, como o stand-in real — é
 * ele que o motor precisa esconder. Sem isso, o teste do "esconde o redondo"
 * passaria sem ter nada para esconder.
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

describe("animação v6 — coreografia", () => {
  it("a silhueta do motor deforma quadro a quadro", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const controller = await montar(host, "working", 190);

    const silhueta = host.querySelector<SVGPathElement>("[data-grok-silhouette=true]");
    expect(silhueta).toBeTruthy();

    await quadros(4);
    const primeiro = silhueta?.getAttribute("d") ?? "";
    await quadros(6);
    const segundo = silhueta?.getAttribute("d") ?? "";

    // Spline fechado de 56 pontos, interpolado por quadro: o `d` é longo e muda.
    expect(primeiro.length).toBeGreaterThan(200);
    expect(segundo).not.toBe(primeiro);

    controller.destroy();
    host.remove();
  });

  it("esconde o corpo redondo que veio do módulo", async () => {
    // São DUAS silhuetas no mesmo lugar: a redonda do export do Lab e a orgânica
    // que o motor gera. Deixar as duas visíveis desenharia um círculo por baixo
    // da forma que deveria substituí-lo.
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

  it("empilha silhueta, rosto e cena nessa ordem", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const controller = await montar(host, "working", 190);

    const root = host.querySelector(".gpv6-root");
    const ordem = [...(root?.children ?? [])].map((filho) => filho.getAttribute("class"));

    // A ordem do DOM É a ordem de pintura: cena atrás do corpo esconderia o
    // terminal, que era o defeito das versões anteriores.
    expect(ordem).toEqual(["gpv6-body-svg", "gpv6-avatar", "gpv6-art-svg"]);

    controller.destroy();
    host.remove();
  });

  it("num avatar de lista mantém o morph e omite os detalhes", async () => {
    // A lista de tarefas usa 26 px. O morph continua — é ele que se lê nesse
    // tamanho —, mas terminal e gráfico virariam três pixels de borrão.
    const host = document.createElement("div");
    document.body.append(host);
    const controller = await montar(host, "working", 26);
    await quadros(4);

    expect(host.querySelectorAll(".gpv6-art-svg rect, .gpv6-art-svg line").length).toBe(0);

    const silhueta = host.querySelector<SVGPathElement>("[data-grok-silhouette=true]");
    expect((silhueta?.getAttribute("d") ?? "").length).toBeGreaterThan(200);

    controller.destroy();
    host.remove();
  });
});

/**
 * A v6 troca o seno contínuo por CICLOS com preparação e impacto — o morph da
 * v5 existia, mas não tinha intenção. Um ciclo tem antecipação, ação,
 * ultrapassagem, acomodação e pausa.
 */
describe("coreografia v6", () => {
  it("o movimento tem ciclos, não oscilação uniforme", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const controller = await montar(host, "working", 190);

    const silhueta = host.querySelector<SVGPathElement>("[data-grok-silhouette='true']");
    const amostras: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      await quadros(3);
      amostras.push(silhueta?.getAttribute("d") ?? "");
    }

    // Dez amostras espaçadas: um corpo com coreografia passa por formas
    // distintas. Se todas fossem iguais, o motor teria parado; se fossem uma
    // senoide de período curto, voltariam ao mesmo valor.
    expect(new Set(amostras).size).toBeGreaterThanOrEqual(8);

    controller.destroy();
    host.remove();
  });

  it("o conjunto dos olhos recebe direção sem brigar com a expressão", async () => {
    // O módulo expõe `data-grok-eyes-root`; o motor desloca/rotaciona o GRUPO,
    // enquanto o playback emocional continua mexendo em cada olho. Sem essa
    // separação, as duas escritas disputariam o mesmo atributo.
    const host = document.createElement("div");
    document.body.append(host);
    const controller = await montar(host, "working", 190);
    await quadros(6);

    const olhos = host.querySelector<SVGElement>("[data-grok-eyes-root='true']");
    if (olhos) {
      expect(olhos.getAttribute("transform") ?? "").not.toBe("");
    }

    controller.destroy();
    host.remove();
  });
});
