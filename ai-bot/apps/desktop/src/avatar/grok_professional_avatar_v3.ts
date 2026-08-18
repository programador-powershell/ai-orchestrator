import { GrokSlimeCore } from "./GrokSlimeCore";

/**
 * grok_professional_avatar_v3.ts
 *
 * TRUE professional-activity animation layer for a Grok-style procedural avatar.
 *
 * The previous wrapper only changed Avatar Lab expressions; the body stayed a
 * perfect sphere because the exported avatar definition keeps body geometry
 * outside the expression/animation steps.
 *
 * This version adds:
 *   1. continuous body deformation (squash/stretch/skew/lean)
 *   2. optional organic SVG displacement while working
 *   3. black "blob limbs" that visually grow from the character
 *   4. profession-specific choreography
 *   5. 8 specialists x 5 states
 *
 * Specialists:
 *   chat, code, data, design, agent, flow, tuning, security
 *
 * States:
 *   active, owner, working, waiting, completed
 *
 * It is designed to wrap avatar.js exported by Bible Strong Avatar Lab.
 *
 * Example:
 *
 *   const bot = await mountGrokSpecialistAvatar("#bot", {
 *     moduleUrl: "/avatars/grok/avatar.js",
 *     specialist: "code",
 *     state: "working",
 *     size: 240,
 *   });
 *
 *   bot.setState("waiting");
 *   bot.setSpecialist("security");
 *   bot.setState("working");
 */

export type GrokSpecialist =
  | "chat"
  | "code"
  | "data"
  | "design"
  | "agent"
  | "flow"
  | "tuning"
  | "security";

export type GrokSpecialistState =
  | "active"
  | "owner"
  | "working"
  | "waiting"
  | "completed";

export interface AvatarLabInstance {
  play(animation?: string): void;
  pause(): void;
  stop(): void;
  destroy?: () => void;
}

export interface AvatarLabModule {
  availableAnimations: readonly string[];
  createAvatar(
    target: Element | string,
    options?: {
      animation?: string;
      size?: number | string;
      autoplay?: boolean;
      onAnimationEnd?: () => void;
    },
  ): AvatarLabInstance;
}

export interface MountGrokSpecialistOptions {
  moduleUrl: string;
  specialist: GrokSpecialist;
  state?: GrokSpecialistState;
  size?: number | string;

  /**
   * Blob color. The Grok-style preset is black.
   */
  bodyColor?: string;

  /**
   * Accent is only used for task artifacts / status.
   */
  accent?: string;

  /**
   * Strength of body deformation.
   * 0 = none, 1 = intended effect, 1.5 = exaggerated.
   */
  deformation?: number;

  /**
   * REMOVIDA na v8. O feTurbulence saiu junto com o corpo antigo — a deformação
   * agora é do GrokSlimeCore, que a faz na geometria e não por filtro. Deixar a
   * opção aceita e ignorada faria quem a ligasse acreditar ter ligado algo.
   */

  /**
   * Show tiny Owner/completed status cues.
   */
  statusCues?: boolean;
}

export interface GrokSpecialistAvatarController {
  readonly element: HTMLElement;

  getSpecialist(): GrokSpecialist;
  getState(): GrokSpecialistState;

  setSpecialist(specialist: GrokSpecialist): void;
  setState(state: GrokSpecialistState): void;

  setAccent(color: string): void;
  setDeformation(strength: number): void;

  pause(): void;
  resume(): void;
  /** Reinicia a animação de emoção do estado atual. */
  replay(): void;
  destroy(): void;
}

type Point = {
  x: number;
  y: number;
};

type StageNodes = {
  svg: SVGSVGElement;
  frontSvg: SVGSVGElement;
  back: SVGGElement;
  front: SVGGElement;
  artifacts: SVGGElement;
  leftArm: SVGPathElement;
  rightArm: SVGPathElement;
  ownerRing: SVGCircleElement;
  ownerDotA: SVGCircleElement;
  ownerDotB: SVGCircleElement;
  ownerDotC: SVGCircleElement;
  completeBadge: SVGGElement;
  filterId: string;
  turbulence: SVGFETurbulenceElement;
  displacement: SVGFEDisplacementMapElement;
};

const SVG_NS = "http://www.w3.org/2000/svg";
const TAU = Math.PI * 2;

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

const lerp = (a: number, b: number, amount: number): number =>
  a + (b - a) * amount;

const sin01 = (time: number, speed = 1, phase = 0): number =>
  0.5 + 0.5 * Math.sin(time * speed + phase);

const wave = (time: number, speed = 1, phase = 0): number =>
  Math.sin(time * speed + phase);

const pingPong = (time: number): number => {
  const value = ((time % 2) + 2) % 2;
  return value <= 1 ? value : 2 - value;
};

const ease = (value: number): number => {
  const t = clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
};

const makeSvg = <K extends keyof SVGElementTagNameMap>(
  tag: K,
  attributes: Record<string, string | number> = {},
): SVGElementTagNameMap[K] => {
  const node = document.createElementNS(SVG_NS, tag);

  for (const [key, value] of Object.entries(attributes)) {
    node.setAttribute(key, String(value));
  }

  return node;
};

const clear = (node: Element): void => {
  while (node.firstChild) node.removeChild(node.firstChild);
};

const randomId = (): string =>
  typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID().replaceAll("-", "")
    : `${Date.now()}${Math.random().toString(16).slice(2)}`;

const SPECIALIST_ACCENT: Record<GrokSpecialist, string> = {
  chat: "#55c7ff",
  code: "#65df8d",
  data: "#72a7ff",
  design: "#e985ff",
  agent: "#a995ff",
  flow: "#ff9d62",
  tuning: "#f4ce64",
  security: "#5de0c5",
};

const SPECIALIST_LABEL: Record<GrokSpecialist, string> = {
  chat: "Chat",
  code: "Code",
  data: "Data",
  design: "Design",
  agent: "Agent",
  flow: "Fluxo",
  tuning: "Tuning",
  security: "Security",
};

const STATE_LABEL: Record<GrokSpecialistState, string> = {
  active: "Ativo",
  owner: "Owner",
  working: "Trabalhando",
  waiting: "Em espera",
  completed: "Concluído",
};

/**
 * Emotional states from the Avatar Lab vocabulary.
 * The body choreography below is independent from this eye/head expression.
 */
export const GROK_SPECIALIST_BEHAVIOR_MAP: Record<
  GrokSpecialist,
  Record<GrokSpecialistState, readonly string[]>
> = {
  chat: {
    active: ["listening", "idle"],
    owner: ["proud", "listening", "idle"],
    working: ["listening", "working", "thinking"],
    waiting: ["sleeping", "drowsy", "idle"],
    completed: ["happy", "celebrate", "idle"],
  },
  code: {
    active: ["idle", "listening"],
    owner: ["proud", "thinking", "idle"],
    working: ["working", "thinking", "searching"],
    waiting: ["sleeping", "drowsy", "idle"],
    completed: ["celebrate", "happy", "idle"],
  },
  data: {
    active: ["curious", "idle"],
    owner: ["proud", "curious", "idle"],
    working: ["searching", "thinking", "working"],
    waiting: ["sleeping", "drowsy", "idle"],
    completed: ["happy", "celebrate", "idle"],
  },
  design: {
    active: ["curious", "idle"],
    owner: ["proud", "curious", "idle"],
    working: ["curious", "thinking", "working"],
    waiting: ["sleeping", "drowsy", "idle"],
    completed: ["happy", "celebrate", "idle"],
  },
  agent: {
    active: ["listening", "idle"],
    owner: ["proud", "thinking", "idle"],
    working: ["thinking", "searching", "working"],
    waiting: ["sleeping", "drowsy", "idle"],
    completed: ["celebrate", "happy", "idle"],
  },
  flow: {
    active: ["idle", "listening"],
    owner: ["proud", "idle"],
    working: ["working", "searching", "thinking"],
    waiting: ["sleeping", "drowsy", "idle"],
    completed: ["celebrate", "happy", "idle"],
  },
  tuning: {
    active: ["curious", "idle"],
    owner: ["proud", "thinking", "idle"],
    working: ["thinking", "working", "searching"],
    waiting: ["sleeping", "drowsy", "idle"],
    completed: ["happy", "celebrate", "idle"],
  },
  security: {
    active: ["suspicious", "listening", "idle"],
    owner: ["proud", "suspicious", "idle"],
    working: ["searching", "suspicious", "working"],
    waiting: ["sleeping", "drowsy", "idle"],
    completed: ["happy", "celebrate", "idle"],
  },
};

const pickAnimation = (
  available: readonly string[],
  specialist: GrokSpecialist,
  state: GrokSpecialistState,
): string | undefined => {
  const known = new Set(available);

  for (const candidate of GROK_SPECIALIST_BEHAVIOR_MAP[specialist][state]) {
    if (known.has(candidate)) return candidate;
  }

  for (const fallback of ["idle", "listening", "thinking", "working", "sleeping"]) {
    if (known.has(fallback)) return fallback;
  }

  return available[0];
};

const loadModule = async (moduleUrl: string): Promise<AvatarLabModule> => {
  const imported = (await import(
    /* @vite-ignore */
    moduleUrl
  )) as Partial<AvatarLabModule>;

  if (typeof imported.createAvatar !== "function") {
    throw new Error(
      `Avatar module "${moduleUrl}" does not export createAvatar().`,
    );
  }

  if (!Array.isArray(imported.availableAnimations)) {
    throw new Error(
      `Avatar module "${moduleUrl}" does not export availableAnimations.`,
    );
  }

  return imported as AvatarLabModule;
};

const resolveTarget = (target: Element | string): HTMLElement => {
  const element =
    typeof target === "string" ? document.querySelector(target) : target;

  if (!(element instanceof HTMLElement)) {
    throw new Error(`alvo do avatar do especialista não encontrado: ${String(target)}`);
  }

  return element;
};

const ensureStyles = (): void => {
  if (document.getElementById("gsa-style")) return;

  const style = document.createElement("style");
  style.id = "gsa-style";
  style.textContent = `
.gsa-root {
  --gsa-size: 240px;
  --gsa-accent: #55c7ff;
  --gsa-body: #000;
  position: relative;
  width: var(--gsa-size);
  height: var(--gsa-size);
  overflow: visible;
  isolation: isolate;
  user-select: none;
  -webkit-user-select: none;
}

.gsa-stage,
.gsa-art-layer {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: visible;
  pointer-events: none;
}

.gsa-stage {
  z-index: 1;
}

.gsa-avatar {
  position: absolute;
  inset: 11%;
  z-index: 2;
  transform-origin: 50% 55%;
  will-change: transform, filter;
}

.gsa-avatar > * {
  width: 100% !important;
  height: 100% !important;
}

.gsa-art-layer {
  z-index: 3;
}

.gsa-blob-limb {
  fill: none;
  stroke: var(--gsa-body);
  stroke-width: 15;
  stroke-linecap: round;
  stroke-linejoin: round;
  opacity: 0;
  transition: opacity 180ms ease;
}

.gsa-root[data-state="working"] .gsa-blob-limb,
.gsa-root[data-state="owner"] .gsa-blob-limb {
  opacity: 1;
}

.gsa-owner-ring {
  fill: none;
  stroke: var(--gsa-accent);
  stroke-width: 1.5;
  stroke-dasharray: 10 8;
  opacity: 0;
  transform-origin: 100px 100px;
}

.gsa-root[data-state="owner"] .gsa-owner-ring {
  opacity: .72;
  animation: gsa-owner-ring 8s linear infinite;
}

.gsa-owner-dot {
  fill: var(--gsa-accent);
  opacity: 0;
}

.gsa-root[data-state="owner"] .gsa-owner-dot {
  opacity: .9;
  animation: gsa-owner-dot 1.9s ease-in-out infinite;
}

.gsa-complete {
  color: var(--gsa-accent);
  opacity: 0;
  transform-origin: 169px 169px;
}

.gsa-root[data-state="completed"] .gsa-complete {
  opacity: 1;
  animation: gsa-complete 2.5s ease-in-out infinite;
}

@keyframes gsa-owner-ring {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

@keyframes gsa-owner-dot {
  0%,100% { transform: scale(.72); opacity: .45; }
  50% { transform: scale(1.15); opacity: 1; }
}

@keyframes gsa-complete {
  0%,70%,100% { transform: scale(.94); opacity: .72; }
  82% { transform: scale(1.12); opacity: 1; }
}

@media (prefers-reduced-motion: reduce) {
  .gsa-root * {
    animation-duration: 1ms !important;
    animation-iteration-count: 1 !important;
  }
}
`;

  document.head.appendChild(style);
};

const createStage = (): StageNodes => {
  const filterId = `gsa-warp-${randomId()}`;

  const svg = makeSvg("svg", {
    class: "gsa-stage",
    viewBox: "0 0 200 200",
    "aria-hidden": "true",
  });

  const defs = makeSvg("defs");

  const filter = makeSvg("filter", {
    id: filterId,
    x: "-30%",
    y: "-30%",
    width: "160%",
    height: "160%",
  });

  const turbulence = makeSvg("feTurbulence", {
    type: "fractalNoise",
    baseFrequency: "0.012 0.017",
    numOctaves: 2,
    seed: 7,
    result: "noise",
  });

  const displacement = makeSvg("feDisplacementMap", {
    in: "SourceGraphic",
    in2: "noise",
    scale: 0,
    xChannelSelector: "R",
    yChannelSelector: "G",
  });

  filter.appendChild(turbulence);
  filter.appendChild(displacement);
  defs.appendChild(filter);
  svg.appendChild(defs);

  const back = makeSvg("g");
  const front = makeSvg("g");
  const artifacts = makeSvg("g");

  const leftArm = makeSvg("path", {
    class: "gsa-blob-limb",
    d: "M82 112 C70 120 63 129 58 139",
  });

  const rightArm = makeSvg("path", {
    class: "gsa-blob-limb",
    d: "M118 112 C130 120 137 129 142 139",
  });

  back.appendChild(leftArm);
  back.appendChild(rightArm);

  const ownerRing = makeSvg("circle", {
    class: "gsa-owner-ring",
    cx: 100,
    cy: 100,
    r: 88,
  });

  front.appendChild(ownerRing);

  const ownerDotA = makeSvg("circle", {
    class: "gsa-owner-dot",
    cx: 83,
    cy: 12,
    r: 2.2,
  });

  const ownerDotB = makeSvg("circle", {
    class: "gsa-owner-dot",
    cx: 100,
    cy: 8,
    r: 3,
    style: "animation-delay:180ms",
  });

  const ownerDotC = makeSvg("circle", {
    class: "gsa-owner-dot",
    cx: 117,
    cy: 12,
    r: 2.2,
    style: "animation-delay:360ms",
  });

  front.appendChild(ownerDotA);
  front.appendChild(ownerDotB);
  front.appendChild(ownerDotC);

  const completeBadge = makeSvg("g", {
    class: "gsa-complete",
    transform: "translate(169 169)",
  });

  completeBadge.appendChild(
    makeSvg("circle", {
      cx: 0,
      cy: 0,
      r: 16,
      fill: "none",
      stroke: "currentColor",
      "stroke-width": 1.5,
      opacity: 0.38,
    }),
  );

  completeBadge.appendChild(
    makeSvg("path", {
      d: "M-8 0 L-2 6 L10 -8",
      fill: "none",
      stroke: "currentColor",
      "stroke-width": 3,
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
    }),
  );

  front.appendChild(completeBadge);

  // DUAS camadas, e não uma.
  //
  // O CSS deste arquivo já descrevia `.gsa-art-layer` em z-index 3, mas nada a
  // criava: artefatos e status voltaram para dentro do stage único, ou seja,
  // ATRÁS do corpo. Com o slime preto por cima, o terminal, o gráfico, a bézier
  // e o scanner simplesmente somem — que é o defeito que a ordem
  // braços -> corpo -> cena existe para impedir.
  svg.appendChild(back);

  const frontSvg = makeSvg("svg", {
    class: "gsa-art-layer",
    viewBox: "0 0 200 200",
    "aria-hidden": "true",
  });
  frontSvg.appendChild(artifacts);
  frontSvg.appendChild(front);

  return {
    svg,
    frontSvg,
    back,
    front,
    artifacts,
    leftArm,
    rightArm,
    ownerRing,
    ownerDotA,
    ownerDotB,
    ownerDotC,
    completeBadge,
    filterId,
    turbulence,
    displacement,
  };
};

/**
 * Non-round baseline for every professional.
 *
 * Even when merely ACTIVE, specialists do not all sit in the same perfect circle.
 */
/**
 * O bloco de pose corporal antigo foi removido.
 *
 * A animação profissional (renderProfessionActivity) continua abaixo sem
 * alteração; o corpo agora é exclusivamente responsabilidade de GrokSlimeCore.
 */

/**
 * Ponto a `progress` (0..1) ao longo de uma polilinha.
 * Mantido da versão Claude porque a animação profissional usa esse helper
 * em Dados e Fluxo.
 */
const pointAlong = (
  points: readonly Point[],
  progress: number,
  easing: (value: number) => number = (value) => value,
): Point | null => {
  if (points.length < 2) return null;

  const scaled = clamp(progress, 0, 1) * (points.length - 1);
  const index = Math.min(points.length - 2, Math.floor(scaled));
  const a = points[index];
  const b = points[index + 1];

  if (!a || !b) return null;

  const local = easing(scaled - index);
  return {
    x: lerp(a.x, b.x, local),
    y: lerp(a.y, b.y, local),
  };
};

const armPath = (
  shoulder: Point,
  control: Point,
  hand: Point,
): string =>
  `M${shoulder.x.toFixed(2)} ${shoulder.y.toFixed(2)} ` +
  `Q${control.x.toFixed(2)} ${control.y.toFixed(2)} ` +
  `${hand.x.toFixed(2)} ${hand.y.toFixed(2)}`;

const hideArms = (stage: StageNodes): void => {
  stage.leftArm.style.opacity = "0";
  stage.rightArm.style.opacity = "0";
};

const showArms = (
  stage: StageNodes,
  left: { shoulder: Point; control: Point; hand: Point } | null,
  right: { shoulder: Point; control: Point; hand: Point } | null,
): void => {
  if (left) {
    stage.leftArm.setAttribute(
      "d",
      armPath(left.shoulder, left.control, left.hand),
    );
    stage.leftArm.style.opacity = "1";
  } else {
    stage.leftArm.style.opacity = "0";
  }

  if (right) {
    stage.rightArm.setAttribute(
      "d",
      armPath(right.shoulder, right.control, right.hand),
    );
    stage.rightArm.style.opacity = "1";
  } else {
    stage.rightArm.style.opacity = "0";
  }
};

const circle = (
  group: SVGElement,
  cx: number,
  cy: number,
  r: number,
  fill: string,
  opacity = 1,
): SVGCircleElement => {
  const node = makeSvg("circle", { cx, cy, r, fill, opacity });
  group.appendChild(node);
  return node;
};

const line = (
  group: SVGElement,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  stroke: string,
  width = 2,
  opacity = 1,
): SVGLineElement => {
  const node = makeSvg("line", {
    x1,
    y1,
    x2,
    y2,
    stroke,
    "stroke-width": width,
    "stroke-linecap": "round",
    opacity,
  });
  group.appendChild(node);
  return node;
};

const path = (
  group: SVGElement,
  d: string,
  stroke: string,
  width = 2,
  fill = "none",
  opacity = 1,
): SVGPathElement => {
  const node = makeSvg("path", {
    d,
    stroke,
    "stroke-width": width,
    fill,
    opacity,
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
  });
  group.appendChild(node);
  return node;
};

const rect = (
  group: SVGElement,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
  stroke: string,
  fill = "none",
  opacity = 1,
): SVGRectElement => {
  const node = makeSvg("rect", {
    x,
    y,
    width,
    height,
    rx: radius,
    stroke,
    fill,
    opacity,
    "stroke-width": 1.8,
  });
  group.appendChild(node);
  return node;
};

/**
 * Profession-specific scene.
 *
 * These are not static badges: the blob's arms physically reach into the scene
 * and manipulate the professional artifact.
 */
const renderProfessionActivity = (
  stage: StageNodes,
  specialist: GrokSpecialist,
  state: GrokSpecialistState,
  time: number,
  accent: string,
  bodyColor: string,
): void => {
  clear(stage.artifacts);

  if (state === "waiting") {
    hideArms(stage);

    const z1 = makeSvg("text", {
      x: 150,
      y: 58,
      fill: accent,
      opacity: 0.55,
      "font-size": 12,
      "font-weight": 700,
    });
    z1.textContent = "Z";

    const z2 = makeSvg("text", {
      x: 165,
      y: 42,
      fill: accent,
      opacity: 0.28,
      "font-size": 9,
      "font-weight": 700,
    });
    z2.textContent = "z";

    stage.artifacts.appendChild(z1);
    stage.artifacts.appendChild(z2);
    return;
  }

  if (state === "completed") {
    hideArms(stage);
    return;
  }

  const working = state === "working";
  const owner = state === "owner";
  const energy = working ? 1 : owner ? 0.55 : 0.25;

  switch (specialist) {
    case "chat": {
      /**
       * CHAT:
       * Two bubbles alternate; the blob leans into the active side.
       */
      const leftActive = sin01(time, working ? 2.4 : 0.8) > 0.5;

      rect(
        stage.artifacts,
        15,
        52,
        44,
        29,
        11,
        accent,
        leftActive ? `${accent}16` : "none",
        leftActive ? 0.9 : 0.34,
      );

      rect(
        stage.artifacts,
        141,
        72,
        44,
        29,
        11,
        accent,
        !leftActive ? `${accent}16` : "none",
        !leftActive ? 0.9 : 0.34,
      );

      const dots: ReadonlyArray<readonly [number, number]> = leftActive
        ? [
            [28, 66],
            [37, 66],
            [46, 66],
          ]
        : [
            [154, 86],
            [163, 86],
            [172, 86],
          ];

      dots.forEach(([x, y], index) => {
        const pulse = 1 + sin01(time, 6, index * 0.8) * 1.5;
        circle(stage.artifacts, x, y, pulse, accent, 0.7);
      });

      if (working) {
        const hand = leftActive
          ? { x: 57, y: 76 }
          : { x: 143, y: 92 };

        showArms(
          stage,
          leftActive
            ? {
                shoulder: { x: 78, y: 112 },
                control: { x: 65, y: 102 },
                hand,
              }
            : null,
          !leftActive
            ? {
                shoulder: { x: 122, y: 112 },
                control: { x: 135, y: 108 },
                hand,
              }
            : null,
        );
      } else {
        hideArms(stage);
      }
      break;
    }

    case "code": {
      /**
       * CODE:
       * The blob bends forward over a terminal and taps keys with both limbs.
       */
      rect(stage.artifacts, 42, 125, 116, 45, 8, accent, "#07090b", 0.82);
      line(stage.artifacts, 51, 137, 78, 137, accent, 2, 0.78);
      line(stage.artifacts, 51, 147, 91, 147, accent, 2, 0.42);
      line(stage.artifacts, 51, 157, 72, 157, accent, 2, 0.55);

      const cursorX = 83 + pingPong(time * 2.2) * 43;
      line(stage.artifacts, cursorX, 136, cursorX, 148, accent, 2, 0.9);

      if (working) {
        const tapL = 138 + Math.max(0, wave(time, 10)) * 6;
        const tapR = 138 + Math.max(0, wave(time, 10, Math.PI)) * 6;

        showArms(
          stage,
          {
            shoulder: { x: 80, y: 112 },
            control: { x: 70, y: 126 },
            hand: { x: 73, y: tapL },
          },
          {
            shoulder: { x: 120, y: 112 },
            control: { x: 130, y: 126 },
            hand: { x: 125, y: tapR },
          },
        );

        circle(stage.artifacts, 73, tapL + 3, 2.2, bodyColor, 0.95);
        circle(stage.artifacts, 125, tapR + 3, 2.2, bodyColor, 0.95);
      } else {
        hideArms(stage);
      }
      break;
    }

    case "data": {
      /**
       * DATA:
       * One limb follows the current graph point while the body itself stretches.
       */
      const baseY = 160;

      const alturas = [0.32, 0.64, 0.47, 0.82];

      [27, 44, 61, 78].forEach((x, index) => {
        const h =
          15 +
          (alturas[index] ?? 0) * 45 +
          wave(time, working ? 2.3 : 0.7, index) * 4 * energy;

        rect(
          stage.artifacts,
          x,
          baseY - h,
          10,
          h,
          3,
          accent,
          `${accent}16`,
          0.48 + index * 0.1,
        );
      });

      const points = [
        { x: 28, y: 119 },
        { x: 48, y: 105 },
        { x: 70, y: 114 },
        { x: 94, y: 87 },
        { x: 121, y: 99 },
        { x: 150, y: 70 },
        { x: 172, y: 80 },
      ];

      path(
        stage.artifacts,
        `M${points.map((p) => `${p.x} ${p.y}`).join(" L")}`,
        accent,
        2,
        "none",
        0.48,
      );

      points.forEach((p) => circle(stage.artifacts, p.x, p.y, 2.5, accent, 0.7));

      const current = working ? pointAlong(points, pingPong(time * 0.7)) : null;

      if (current) {
        circle(stage.artifacts, current.x, current.y, 5, accent, 0.28);
        circle(stage.artifacts, current.x, current.y, 2.2, accent, 0.95);

        showArms(
          stage,
          null,
          {
            shoulder: { x: 121, y: 106 },
            control: {
              x: lerp(133, current.x, 0.55),
              y: lerp(111, current.y, 0.55),
            },
            hand: current,
          },
        );
      } else {
        hideArms(stage);
      }
      break;
    }

    case "design": {
      /**
       * DESIGN:
       * The right limb literally drags a Bézier control point.
       */
      const p0 = { x: 25, y: 148 };
      const p3 = { x: 173, y: 111 };
      const controlA = {
        x: 58 + wave(time, working ? 1.8 : 0.5) * 8 * energy,
        y: 65 + wave(time, working ? 1.4 : 0.4) * 11 * energy,
      };
      const controlB = {
        x: 132 + wave(time, working ? 1.6 : 0.4, 1) * 9 * energy,
        y: 168 + wave(time, working ? 1.2 : 0.35, 2) * 8 * energy,
      };

      path(
        stage.artifacts,
        `M${p0.x} ${p0.y} C${controlA.x} ${controlA.y} ${controlB.x} ${controlB.y} ${p3.x} ${p3.y}`,
        accent,
        2.2,
        "none",
        0.8,
      );

      line(
        stage.artifacts,
        p0.x,
        p0.y,
        controlA.x,
        controlA.y,
        accent,
        1,
        0.25,
      );
      line(
        stage.artifacts,
        p3.x,
        p3.y,
        controlB.x,
        controlB.y,
        accent,
        1,
        0.25,
      );

      [p0, p3, controlA, controlB].forEach((p, index) =>
        circle(stage.artifacts, p.x, p.y, index < 2 ? 3 : 2.5, accent, 0.76),
      );

      if (working) {
        showArms(
          stage,
          null,
          {
            shoulder: { x: 120, y: 106 },
            control: { x: 130, y: 92 },
            hand: controlB,
          },
        );

        circle(
          stage.artifacts,
          controlB.x,
          controlB.y,
          6,
          "none",
          0,
        ).setAttribute("stroke", accent);
      } else {
        hideArms(stage);
      }
      break;
    }

    case "agent": {
      /**
       * AGENT:
       * Child blobs bud out from the main bot, orbit, then return.
       */
      const center = { x: 100, y: 100 };
      const count = 4;

      for (let i = 0; i < count; i++) {
        const phase = i / count;
        const dispatch = sin01(time, 1.4, phase * TAU);
        const radius = 32 + dispatch * 42;
        const angle = time * 0.55 + phase * TAU;

        const x = center.x + Math.cos(angle) * radius;
        const y = center.y + Math.sin(angle) * radius * 0.72;

        line(
          stage.artifacts,
          center.x,
          center.y,
          x,
          y,
          accent,
          1,
          0.12 + dispatch * 0.24,
        );

        circle(
          stage.artifacts,
          x,
          y,
          3.5 + dispatch * 3.8,
          bodyColor,
          0.55 + dispatch * 0.4,
        );

        circle(
          stage.artifacts,
          x,
          y,
          1.6,
          accent,
          0.35 + dispatch * 0.6,
        );
      }

      if (working) {
        const p = pingPong(time * 1.5);
        showArms(
          stage,
          {
            shoulder: { x: 80, y: 109 },
            control: { x: 66, y: 100 },
            hand: { x: 48 - p * 12, y: 78 + p * 9 },
          },
          {
            shoulder: { x: 120, y: 109 },
            control: { x: 134, y: 100 },
            hand: { x: 152 + p * 12, y: 78 + p * 9 },
          },
        );
      } else {
        hideArms(stage);
      }
      break;
    }

    case "flow": {
      /**
       * FLOW:
       * Trigger -> condition -> action.
       * The blob passes a packet from node to node with alternating limbs.
       */
      const nodes = [
        { x: 24, y: 132 },
        { x: 66, y: 108 },
        { x: 111, y: 138 },
        { x: 162, y: 104 },
      ];

      path(
        stage.artifacts,
        `M${nodes.map((n) => `${n.x} ${n.y}`).join(" L")}`,
        accent,
        2,
        "none",
        0.32,
      );

      nodes.forEach((node, index) => {
        if (index === 1) {
          stage.artifacts.appendChild(
            makeSvg("path", {
              d: `M${node.x} ${node.y - 7} L${node.x + 7} ${node.y} L${node.x} ${node.y + 7} L${node.x - 7} ${node.y} Z`,
              fill: `${accent}14`,
              stroke: accent,
              "stroke-width": 1.8,
              opacity: 0.76,
            }),
          );
        } else {
          circle(stage.artifacts, node.x, node.y, 6, `${accent}18`, 1).setAttribute(
            "stroke",
            accent,
          );
        }
      });

      const packet = working ? pointAlong(nodes, (time * 0.48) % 1, ease) : null;

      if (packet) {
        circle(stage.artifacts, packet.x, packet.y, 4.5, accent, 0.92);
        circle(stage.artifacts, packet.x, packet.y, 8, accent, 0.12);

        const useLeft = packet.x < 100;

        showArms(
          stage,
          useLeft
            ? {
                shoulder: { x: 80, y: 111 },
                control: { x: 69, y: 121 },
                hand: packet,
              }
            : null,
          !useLeft
            ? {
                shoulder: { x: 120, y: 111 },
                control: { x: 132, y: 119 },
                hand: packet,
              }
            : null,
        );
      } else {
        hideArms(stage);
      }
      break;
    }

    case "tuning": {
      /**
       * TUNING:
       * Both limbs move real slider knobs up/down the rails.
       */
      const rows = [126, 145, 164];
      const phases = [0, 1.7, 3.4];

      rows.forEach((y, index) => {
        line(stage.artifacts, 38, y, 162, y, accent, 1.4, 0.3);

        const x =
          62 +
          sin01(time, working ? 2.6 + index * 0.4 : 0.5, phases[index]) * 76;

        circle(stage.artifacts, x, y, 5, accent, 0.82);
      });

      if (working) {
        const xA = 62 + sin01(time, 2.6, 0) * 76;
        const xB = 62 + sin01(time, 3.0, 1.7) * 76;

        showArms(
          stage,
          {
            shoulder: { x: 80, y: 111 },
            control: { x: 70, y: 128 },
            hand: { x: xA, y: 126 },
          },
          {
            shoulder: { x: 120, y: 111 },
            control: { x: 130, y: 138 },
            hand: { x: xB, y: 145 },
          },
        );
      } else {
        hideArms(stage);
      }
      break;
    }

    case "security": {
      /**
       * SECURITY:
       * The blob braces into a wider stance while one limb sweeps a scanner
       * over a shield-like target.
       */
      path(
        stage.artifacts,
        "M100 119 L145 135 V153 Q143 176 100 190 Q57 176 55 153 V135 Z",
        accent,
        1.8,
        `${accent}0d`,
        0.45,
      );

      if (working) {
        const scan = pingPong(time * 1.15);
        const y = lerp(136, 177, scan);
        const width = 28 + Math.sin(scan * Math.PI) * 15;

        line(
          stage.artifacts,
          100 - width,
          y,
          100 + width,
          y,
          accent,
          2,
          0.92,
        );

        showArms(
          stage,
          null,
          {
            shoulder: { x: 120, y: 111 },
            control: { x: 137, y: 122 },
            hand: { x: 100 + width, y },
          },
        );

        circle(stage.artifacts, 100 + width, y, 4, accent, 0.88);
      } else {
        hideArms(stage);
      }
      break;
    }
  }
};

/**
 * Abaixo deste tamanho a cena profissional não é desenhada — ver o campo
 * `scene`. 96px é onde um terminal de 116 unidades no viewBox ainda tem traço
 * legível; a lista de tarefas usa 26px e a ficha de presença, 124px.
 */
const SCENE_MIN_PX = 96;

/** ~24 quadros por segundo para a cena. O corpo continua a 60. */
const SCENE_FRAME_MS = 42;

class GrokAvatarController implements GrokSpecialistAvatarController {
  readonly element: HTMLElement;

  private readonly module: AvatarLabModule;
  private readonly avatar: AvatarLabInstance;
  private readonly root: HTMLDivElement;
  private readonly avatarHost: HTMLDivElement;
  private readonly stage: StageNodes;
  private readonly reduceMotion: boolean;
  private readonly slime: GrokSlimeCore;
  /**
   * A cena profissional é desenhada num viewBox de 200x200 — um terminal, um
   * gráfico, três sliders. Aos 26px da lista de tarefas ela é ilegível, e
   * reconstruí-la a cada quadro custaria ~15 nós SVG por avatar, 60 vezes por
   * segundo, para produzir borrão. O CORPO deformado continua animando em todo
   * tamanho: é ele que se lê pequeno.
   */
  private readonly scene: boolean;
  private lastScene = 0;

  private specialist: GrokSpecialist;
  private state: GrokSpecialistState;
  private accent: string;
  private bodyColor: string;
  private deformation: number;

  private raf = 0;
  private destroyed = false;
  private paused = false;

  private startTime = performance.now();
  private lastFrame = performance.now();


  constructor(params: {
    element: HTMLElement;
    module: AvatarLabModule;
    avatar: AvatarLabInstance;
    root: HTMLDivElement;
    avatarHost: HTMLDivElement;
    stage: StageNodes;
    specialist: GrokSpecialist;
    state: GrokSpecialistState;
    accent: string;
    bodyColor: string;
    deformation: number;
    scene: boolean;
  }) {
    this.element = params.element;
    this.module = params.module;
    this.avatar = params.avatar;
    this.root = params.root;
    this.avatarHost = params.avatarHost;
    this.stage = params.stage;
    this.specialist = params.specialist;
    this.state = params.state;
    this.accent = params.accent;
    this.bodyColor = params.bodyColor;
    this.deformation = params.deformation;
    this.scene = params.scene;

    // O motor GrokSlimeCore substitui SOMENTE o corpo. A cena profissional
    // abaixo permanece a implementação original.
    this.avatarHost.style.transform = "none";
    this.avatarHost.style.filter = "none";
    this.slime = new GrokSlimeCore({
      svg: this.stage.svg,
      before: this.stage.back,
      avatarHost: this.avatarHost,
      bodyColor: this.bodyColor,
    });

    this.reduceMotion =
      typeof matchMedia !== "undefined" &&
      matchMedia("(prefers-reduced-motion: reduce)").matches;

    this.applyIdentity();
    this.playEmotion();
    this.loop = this.loop.bind(this);
    this.raf = requestAnimationFrame(this.loop);
  }

  getSpecialist(): GrokSpecialist {
    return this.specialist;
  }

  getState(): GrokSpecialistState {
    return this.state;
  }

  setSpecialist(specialist: GrokSpecialist): void {
    if (specialist === this.specialist) return;

    this.specialist = specialist;
    this.accent = SPECIALIST_ACCENT[specialist];
    this.applyIdentity();
    this.playEmotion();
  }

  setState(state: GrokSpecialistState): void {
    if (state === this.state) return;

    this.state = state;
    this.applyIdentity();
    this.playEmotion();
  }

  setAccent(color: string): void {
    this.accent = color;
    this.root.style.setProperty("--gsa-accent", color);
  }

  setDeformation(strength: number): void {
    this.deformation = clamp(strength, 0, 2);
  }

  replay(): void {
    this.playEmotion();
  }

  pause(): void {
    this.paused = true;
    this.avatar.pause();
  }

  resume(): void {
    this.paused = false;
    this.lastFrame = performance.now();
    this.playEmotion();
  }

  destroy(): void {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    this.slime.destroy();
    this.avatar.destroy?.();
    this.root.remove();
  }

  private applyIdentity(): void {
    this.root.dataset.specialist = this.specialist;
    this.root.dataset.state = this.state;
    this.root.style.setProperty("--gsa-accent", this.accent);
    this.root.style.setProperty("--gsa-body", this.bodyColor);
    this.root.setAttribute(
      "aria-label",
      `${SPECIALIST_LABEL[this.specialist]} — ${STATE_LABEL[this.state]}`,
    );
  }

  private playEmotion(): void {
    const animation = pickAnimation(
      this.module.availableAnimations,
      this.specialist,
      this.state,
    );

    if (animation) this.avatar.play(animation);
    else this.avatar.stop();
  }

  private loop(now: number): void {
    if (this.destroyed) return;

    if (!this.paused) {
      const dt = clamp((now - this.lastFrame) / 1000, 0, 0.08);
      this.lastFrame = now;

      const elapsed = this.reduceMotion
        ? 0.7
        : (now - this.startTime) / 1000;

      // A atividade visual da especialidade continua igual; apenas o corpo é
      // entregue ao solver de slime Grok-like, com volume preservado e pressão
      // localizada.
      this.slime.update({
        specialist: this.specialist,
        state: this.state,
        time: elapsed,
        dt,
        strength: this.deformation,
      });

      // A cena é lenta por natureza (um cursor que varre, um pacote que anda),
      // então 24 quadros por segundo bastam. Reconstruí-la a 60 não muda o que
      // se vê e triplica o descarte de nós.
      if (this.scene && now - this.lastScene >= SCENE_FRAME_MS) {
        this.lastScene = now;
        renderProfessionActivity(
          this.stage,
          this.specialist,
          this.state,
          elapsed,
          this.accent,
          this.bodyColor,
        );
      }
    }

    this.raf = requestAnimationFrame(this.loop);
  }
}

export async function mountGrokSpecialistAvatar(
  target: Element | string,
  options: MountGrokSpecialistOptions,
): Promise<GrokSpecialistAvatarController> {
  if (typeof window === "undefined" || typeof document === "undefined") {
    throw new Error(
      "mountGrokSpecialistAvatar() must run in a browser/client runtime.",
    );
  }

  ensureStyles();

  const element = resolveTarget(target);
  const module = await loadModule(options.moduleUrl);

  const specialist = options.specialist;
  const state = options.state ?? "active";
  const accent = options.accent ?? SPECIALIST_ACCENT[specialist];
  const bodyColor = options.bodyColor ?? "#000000";
  const size = options.size ?? 240;
  const deformation = clamp(options.deformation ?? 1, 0, 2);
  // Tamanho em string ("100%") não dá para medir aqui sem layout: assume-se que
  // quem pediu porcentagem quer o avatar grande, e a cena entra.
  const scene = typeof size === "number" ? size >= SCENE_MIN_PX : true;
  const statusCues = options.statusCues ?? true;

  const root = document.createElement("div");
  root.className = "gsa-root";
  root.style.setProperty(
    "--gsa-size",
    typeof size === "number" ? `${size}px` : size,
  );
  root.style.setProperty("--gsa-accent", accent);
  root.style.setProperty("--gsa-body", bodyColor);

  const stage = createStage();

  if (!statusCues) {
    stage.ownerRing.style.display = "none";
    stage.ownerDotA.style.display = "none";
    stage.ownerDotB.style.display = "none";
    stage.ownerDotC.style.display = "none";
    stage.completeBadge.style.display = "none";
  }

  const avatarHost = document.createElement("div");
  avatarHost.className = "gsa-avatar";

  /**
   * Order matters:
   * stage has back limbs,
   * avatar is the procedural body,
   * stage front artifacts are in the same SVG but remain visually peripheral.
   */
  // A ordem do DOM É a ordem de pintura: massa/braços atrás, olhos no meio,
  // cena profissional na frente.
  root.appendChild(stage.svg);
  root.appendChild(avatarHost);
  root.appendChild(stage.frontSvg);

  element.appendChild(root);

  const initialAnimation = pickAnimation(
    module.availableAnimations,
    specialist,
    state,
  );

  const avatar = module.createAvatar(avatarHost, {
    animation: initialAnimation,
    size: "100%",
    autoplay: false,
  });

  return new GrokAvatarController({
    element,
    module,
    avatar,
    root,
    avatarHost,
    stage,
    specialist,
    state,
    accent,
    bodyColor,
    deformation,
    scene,
  });
}

/**
 * Backend/runtime -> emotional state mapper.
 */
export function grokVisualStateFromRuntime(input: {
  isOwner?: boolean;
  completed?: boolean;
  status?: string | null;
}): GrokSpecialistState {
  if (input.completed) return "completed";
  if (input.isOwner) return "owner";

  const status = (input.status ?? "").trim().toUpperCase();

  if (
    status === "ACTIVE" ||
    status === "RUNNING" ||
    status === "STARTING" ||
    status === "VERIFYING"
  ) {
    return "working";
  }

  if (
    status === "WAITING" ||
    status === "WAITING_INPUT" ||
    status === "WAITING_APPROVAL" ||
    status === "BLOCKED_DEPENDENCY" ||
    status === "PAUSED" ||
    status === "HIBERNATED" ||
    status === "QUEUED"
  ) {
    return "waiting";
  }

  if (status === "COMPLETED") return "completed";

  return "active";
}

/**
 * Quick integration demo:
 *
 * const bot = await mountGrokSpecialistAvatar("#bot", {
 *   moduleUrl: "/avatar/avatar.js",
 *   specialist: "design",
 *   state: "working",
 *   size: 260,
 *   deformation: 1,
 * });
 *
 * setTimeout(() => bot.setState("waiting"), 5000);
 * setTimeout(() => bot.setState("working"), 9000);
 * setTimeout(() => bot.setState("completed"), 14000);
 */


/**
 * Aliases para compatibilidade com as versões mais novas do projeto.
 * O motor interno é o mesmo; não existe uma segunda implementação.
 */
export type Specialist = GrokSpecialist;
export type SpecialistState = GrokSpecialistState;
export type ProfessionalGrokController = GrokSpecialistAvatarController;
export type MountProfessionalGrokOptions = MountGrokSpecialistOptions;
export const mountProfessionalGrokAvatar = mountGrokSpecialistAvatar;
export const professionalVisualStateFromRuntime = grokVisualStateFromRuntime;
