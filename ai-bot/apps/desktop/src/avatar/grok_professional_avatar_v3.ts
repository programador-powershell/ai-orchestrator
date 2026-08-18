/**
 * grok_professional_avatar_v3.ts
 *
 * V7 — GROK METABALL RIG
 *
 * Keeps the filename/API expected by the project, but replaces the previous
 * "single deformed silhouette + professional overlay" renderer.
 *
 * Core visual rule:
 *   THE PROFESSION IS PERFORMED BY THE CREATURE'S OWN BLACK MASS.
 *
 * The body is built from SVG metaballs (central mass + chains of organic nodes)
 * fused with a goo filter. Limbs are therefore not line-art arms sitting on
 * top of a ball: they visually grow out of the same black material.
 *
 * Avatar Lab / grok-avatar.js is used for the white eyes and emotional playback.
 *
 * Specialists:
 *   chat, code, data, design, agent, flow, tuning, security
 *
 * States:
 *   active, owner, working, waiting, completed
 */

export type Specialist =
  | "chat"
  | "code"
  | "data"
  | "design"
  | "agent"
  | "flow"
  | "tuning"
  | "security";

export type SpecialistState =
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

export interface MountProfessionalGrokOptions {
  moduleUrl: string;
  specialist: Specialist;
  state?: SpecialistState;
  size?: number | string;
  bodyColor?: string;
  accent?: string;
  deformation?: number;
  organicWarp?: boolean;
  statusCues?: boolean;
}

export interface ProfessionalGrokController {
  readonly element: HTMLElement;
  getSpecialist(): Specialist;
  getState(): SpecialistState;
  setSpecialist(specialist: Specialist): void;
  setState(state: SpecialistState): void;
  setAccent(color: string): void;
  setDeformation(strength: number): void;
  pause(): void;
  resume(): void;
  destroy(): void;
}

type Point = { x: number; y: number };

type BodyPose = {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  rotation: number;
};

type ChainPose = {
  visible: boolean;
  from: Point;
  control: Point;
  to: Point;
  thickness: number;
  tip: number;
  detach?: number;
};

type RigPose = {
  body: BodyPose;
  chains: ChainPose[];
  gaze: {
    x: number;
    y: number;
    rotation: number;
    scaleX: number;
    scaleY: number;
  };
};

type Scene = {
  root: HTMLDivElement;
  bodySvg: SVGSVGElement;
  artSvg: SVGSVGElement;
  gooGroup: SVGGElement;
  bodyEllipse: SVGEllipseElement;
  bodyGlow: SVGEllipseElement;
  shadow: SVGEllipseElement;
  chainNodes: SVGCircleElement[][];
  artifacts: SVGGElement;
  ownerRing: SVGCircleElement;
  ownerDots: SVGCircleElement[];
  completed: SVGGElement;
};

type Spring = {
  value: number;
  velocity: number;
};

type SpringPoint = {
  x: Spring;
  y: Spring;
};

const SVG_NS = "http://www.w3.org/2000/svg";
const MAX_CHAINS = 4;
const NODES_PER_CHAIN = 7;
const EYE_COORD_SCALE = 0.709;

const clamp = (v: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, v));

const lerp = (a: number, b: number, t: number): number =>
  a + (b - a) * t;

const smooth = (t: number): number => {
  const p = clamp(t, 0, 1);
  return p * p * (3 - 2 * p);
};

const smoother = (t: number): number => {
  const p = clamp(t, 0, 1);
  return p * p * p * (p * (p * 6 - 15) + 10);
};

const wave = (t: number, speed = 1, phase = 0): number =>
  Math.sin(t * speed + phase);

const bezier = (a: Point, c: Point, b: Point, t: number): Point => {
  const u = 1 - t;
  return {
    x: u * u * a.x + 2 * u * t * c.x + t * t * b.x,
    y: u * u * a.y + 2 * u * t * c.y + t * t * b.y,
  };
};

const makeSvg = <K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
): SVGElementTagNameMap[K] => {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    node.setAttribute(key, String(value));
  }
  return node;
};

const clear = (node: Element): void => {
  while (node.firstChild) node.removeChild(node.firstChild);
};

const SPECIALIST_ACCENT: Record<Specialist, string> = {
  chat: "#55c7ff",
  code: "#65df8d",
  data: "#72a7ff",
  design: "#e985ff",
  agent: "#a995ff",
  flow: "#ff9d62",
  tuning: "#f4ce64",
  security: "#5de0c5",
};

const SPECIALIST_LABEL: Record<Specialist, string> = {
  chat: "Chat",
  code: "Código",
  data: "Dados",
  design: "Design",
  agent: "Equipe",
  flow: "Fluxo",
  tuning: "Tuning",
  security: "Segurança",
};

const STATE_LABEL: Record<SpecialistState, string> = {
  active: "Ativo",
  owner: "Owner",
  working: "Trabalhando",
  waiting: "Em espera",
  completed: "Concluído",
};

export const ANIMATION_CANDIDATES: Record<
  Specialist,
  Record<SpecialistState, readonly string[]>
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
  specialist: Specialist,
  state: SpecialistState,
): string | undefined => {
  const set = new Set(available);

  for (const candidate of ANIMATION_CANDIDATES[specialist][state]) {
    if (set.has(candidate)) return candidate;
  }

  for (const fallback of ["idle", "listening", "thinking", "working", "sleeping"]) {
    if (set.has(fallback)) return fallback;
  }

  return available[0];
};

const resolveTarget = (target: Element | string): HTMLElement => {
  const node =
    typeof target === "string" ? document.querySelector(target) : target;

  if (!(node instanceof HTMLElement)) {
    throw new Error(`Professional Grok target not found: ${String(target)}`);
  }

  return node;
};

const loadModule = async (moduleUrl: string): Promise<AvatarLabModule> => {
  const imported = (await import(
    /* @vite-ignore */
    moduleUrl
  )) as Partial<AvatarLabModule>;

  if (typeof imported.createAvatar !== "function") {
    throw new Error(`Avatar module "${moduleUrl}" does not export createAvatar().`);
  }

  if (!Array.isArray(imported.availableAnimations)) {
    throw new Error(
      `Avatar module "${moduleUrl}" does not export availableAnimations.`,
    );
  }

  return imported as AvatarLabModule;
};

const ensureStyles = (): void => {
  if (document.getElementById("grok-metaball-v7-style")) return;

  const style = document.createElement("style");
  style.id = "grok-metaball-v7-style";
  style.textContent = `
.gmv7-root {
  --gmv7-size: 240px;
  --gmv7-accent: #55c7ff;
  --gmv7-body: #030304;
  position: relative;
  width: var(--gmv7-size);
  height: var(--gmv7-size);
  overflow: visible;
  isolation: isolate;
  user-select: none;
  -webkit-user-select: none;
}

.gmv7-body,
.gmv7-art {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: visible;
  pointer-events: none;
}

.gmv7-body { z-index: 2; }
.gmv7-art { z-index: 4; }

.gmv7-avatar {
  position: absolute;
  inset: 11%;
  z-index: 3;
  display: grid;
  place-items: center;
  pointer-events: none;
}

.gmv7-avatar > * {
  width: 100% !important;
  height: 100% !important;
}

.gmv7-owner-ring {
  fill: none;
  stroke: var(--gmv7-accent);
  stroke-width: 1.25;
  stroke-dasharray: 7 10;
  opacity: 0;
  transform-origin: 100px 100px;
}

.gmv7-root[data-state="owner"] .gmv7-owner-ring {
  opacity: .35;
  animation: gmv7-owner-spin 11s linear infinite;
}

.gmv7-owner-dot {
  fill: var(--gmv7-accent);
  opacity: 0;
}

.gmv7-root[data-state="owner"] .gmv7-owner-dot {
  opacity: .72;
  animation: gmv7-owner-dot 2.2s ease-in-out infinite;
}

.gmv7-complete {
  color: var(--gmv7-accent);
  opacity: 0;
  transform-origin: 171px 171px;
}

.gmv7-root[data-state="completed"] .gmv7-complete {
  opacity: .90;
  animation: gmv7-complete 2.8s ease-in-out infinite;
}

@keyframes gmv7-owner-spin {
  to { transform: rotate(360deg); }
}

@keyframes gmv7-owner-dot {
  0%,100% { opacity: .24; transform: scale(.72); }
  50% { opacity: .95; transform: scale(1.14); }
}

@keyframes gmv7-complete {
  0%,70%,100% { opacity: .58; transform: scale(.94); }
  82% { opacity: 1; transform: scale(1.12); }
}

@media (prefers-reduced-motion: reduce) {
  .gmv7-root * {
    animation-duration: 1ms !important;
    animation-iteration-count: 1 !important;
  }
}
`;
  document.head.appendChild(style);
};

const createScene = (
  size: number | string,
  bodyColor: string,
  accent: string,
  statusCues: boolean,
): Scene => {
  const root = document.createElement("div");
  root.className = "gmv7-root";
  root.style.setProperty(
    "--gmv7-size",
    typeof size === "number" ? `${size}px` : size,
  );
  root.style.setProperty("--gmv7-accent", accent);
  root.style.setProperty("--gmv7-body", bodyColor);

  const bodySvg = makeSvg("svg", {
    class: "gmv7-body",
    viewBox: "0 0 200 200",
    "aria-hidden": "true",
  });

  const defs = makeSvg("defs");
  const gooId = `gmv7-goo-${Math.random().toString(36).slice(2)}`;
  const glowId = `gmv7-glow-${Math.random().toString(36).slice(2)}`;

  const goo = makeSvg("filter", {
    id: gooId,
    x: "-45%",
    y: "-45%",
    width: "190%",
    height: "190%",
    "color-interpolation-filters": "sRGB",
  });

  goo.append(
    makeSvg("feGaussianBlur", {
      in: "SourceGraphic",
      stdDeviation: "5.2",
      result: "blur",
    }),
    makeSvg("feColorMatrix", {
      in: "blur",
      mode: "matrix",
      values:
        "1 0 0 0 0 " +
        "0 1 0 0 0 " +
        "0 0 1 0 0 " +
        "0 0 0 23 -10",
      result: "goo",
    }),
    makeSvg("feComposite", {
      in: "SourceGraphic",
      in2: "goo",
      operator: "atop",
    }),
  );

  const gradient = makeSvg("radialGradient", {
    id: glowId,
    cx: "34%",
    cy: "23%",
    r: "88%",
  });
  gradient.append(
    makeSvg("stop", { offset: "0%", "stop-color": "#2a2b2f" }),
    makeSvg("stop", { offset: "42%", "stop-color": "#0a0a0b" }),
    makeSvg("stop", { offset: "100%", "stop-color": bodyColor }),
  );

  defs.append(goo, gradient);
  bodySvg.appendChild(defs);

  const shadow = makeSvg("ellipse", {
    cx: 100,
    cy: 171,
    rx: 47,
    ry: 7,
    fill: "#000",
    opacity: .22,
  });
  bodySvg.appendChild(shadow);

  const gooGroup = makeSvg("g", {
    // Gancho de teste, reposto a cada pacote. Sem ele, achar a massa no DOM
    // depende da POSIÇÃO dentro do SVG — que muda a cada rearranjo e dá teste
    // verde por acidente. Por favor não remova.
    "data-grok-goo": "true",
    filter: `url(#${gooId})`,
    fill: bodyColor,
  });

  const bodyEllipse = makeSvg("ellipse", {
    cx: 100,
    cy: 100,
    rx: 58,
    ry: 58,
    fill: bodyColor,
  });

  gooGroup.appendChild(bodyEllipse);

  const chainNodes: SVGCircleElement[][] = [];

  for (let chain = 0; chain < MAX_CHAINS; chain++) {
    const nodes: SVGCircleElement[] = [];

    for (let index = 0; index < NODES_PER_CHAIN; index++) {
      const node = makeSvg("circle", {
        cx: 100,
        cy: 100,
        r: 0.01,
        fill: bodyColor,
      });
      gooGroup.appendChild(node);
      nodes.push(node);
    }

    chainNodes.push(nodes);
  }

  bodySvg.appendChild(gooGroup);

  const bodyGlow = makeSvg("ellipse", {
    cx: 100,
    cy: 100,
    rx: 55,
    ry: 55,
    fill: `url(#${glowId})`,
    opacity: .72,
    "pointer-events": "none",
  });
  bodySvg.appendChild(bodyGlow);

  const artSvg = makeSvg("svg", {
    class: "gmv7-art",
    viewBox: "0 0 200 200",
    "aria-hidden": "true",
  });

  const artifacts = makeSvg("g");
  artSvg.appendChild(artifacts);

  const ownerRing = makeSvg("circle", {
    class: "gmv7-owner-ring",
    cx: 100,
    cy: 100,
    r: 88,
  });
  artSvg.appendChild(ownerRing);

  const ownerDots = [
    makeSvg("circle", {
      class: "gmv7-owner-dot",
      cx: 84,
      cy: 14,
      r: 2,
    }),
    makeSvg("circle", {
      class: "gmv7-owner-dot",
      cx: 100,
      cy: 9,
      r: 2.7,
      style: "animation-delay:180ms",
    }),
    makeSvg("circle", {
      class: "gmv7-owner-dot",
      cx: 116,
      cy: 14,
      r: 2,
      style: "animation-delay:360ms",
    }),
  ];
  ownerDots.forEach((dot) => artSvg.appendChild(dot));

  const completed = makeSvg("g", {
    class: "gmv7-complete",
    transform: "translate(171 171)",
  });
  completed.append(
    makeSvg("circle", {
      cx: 0,
      cy: 0,
      r: 15,
      fill: "none",
      stroke: "currentColor",
      "stroke-width": 1.3,
      opacity: .28,
    }),
    makeSvg("path", {
      d: "M-7 0 L-2 5 L9 -8",
      fill: "none",
      stroke: "currentColor",
      "stroke-width": 3,
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
    }),
  );
  artSvg.appendChild(completed);

  if (!statusCues) {
    ownerRing.style.display = "none";
    ownerDots.forEach((dot) => (dot.style.display = "none"));
    completed.style.display = "none";
  }

  root.append(bodySvg, artSvg);

  return {
    root,
    bodySvg,
    artSvg,
    gooGroup,
    bodyEllipse,
    bodyGlow,
    shadow,
    chainNodes,
    artifacts,
    ownerRing,
    ownerDots,
    completed,
  };
};

type Gesture = {
  p: number;
  cycle: number;
  action: number;
  anticipation: number;
  overshoot: number;
  settle: number;
};

const gesture = (t: number, period: number, phase = 0): Gesture => {
  const raw = t / period + phase;
  const cycle = Math.floor(raw);
  const p = raw - cycle;

  let action = 0;
  let anticipation = 0;
  let overshoot = 0;
  let settle = 0;

  if (p < .15) {
    anticipation = smoother(p / .15);
    action = -.15 * anticipation;
  } else if (p < .39) {
    const q = smoother((p - .15) / .24);
    anticipation = 1 - q;
    action = lerp(-.15, 1, q);
  } else if (p < .51) {
    const q = smooth((p - .39) / .12);
    overshoot = q;
    action = lerp(1, 1.12, q);
  } else if (p < .73) {
    const q = smoother((p - .51) / .22);
    overshoot = 1 - q;
    settle = q;
    action = lerp(1.12, .72, q);
  } else {
    const q = smoother((p - .73) / .27);
    settle = 1 - q;
    action = lerp(.72, .10, q);
  }

  return { p, cycle, action, anticipation, overshoot, settle };
};

const hiddenChain = (): ChainPose => ({
  visible: false,
  from: { x: 100, y: 100 },
  control: { x: 100, y: 100 },
  to: { x: 100, y: 100 },
  thickness: 10,
  tip: 8,
});

const rigFor = (
  specialist: Specialist,
  state: SpecialistState,
  t: number,
): RigPose => {
  const chains = Array.from({ length: MAX_CHAINS }, hiddenChain);

  if (state === "waiting") {
    return {
      body: {
        cx: 100,
        cy: 124 + wave(t, .75) * .5,
        rx: 68,
        ry: 31,
        rotation: -4,
      },
      chains,
      gaze: {
        x: 0,
        y: 10,
        rotation: -3,
        scaleX: 1.05,
        scaleY: .76,
      },
    };
  }

  if (state === "completed") {
    const g = gesture(t, 2.9);
    const pop = clamp(g.action, 0, 1);

    return {
      body: {
        cx: 100,
        cy: 100 - pop * 4,
        rx: 58 + pop * 5,
        ry: 58 + pop * 6,
        rotation: g.overshoot * 3,
      },
      chains,
      gaze: {
        x: 0,
        y: -1,
        rotation: 0,
        scaleX: 1 + pop * .08,
        scaleY: 1 + pop * .05,
      },
    };
  }

  const owner = state === "owner";
  const breathe = wave(t, 1.0);

  const base: BodyPose = {
    cx: 100 + wave(t, .55) * .5,
    cy: 100 - (owner ? 4 : 0) + wave(t, .77, .4) * .5,
    rx: 58 + breathe * .7 + (owner ? 2 : 0),
    ry: 58 - breathe * .45 + (owner ? 3 : 0),
    rotation: wave(t, .46) * .7,
  };

  if (state !== "working") {
    return {
      body: base,
      chains,
      gaze: {
        x: 0,
        y: owner ? -2 : 0,
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
      },
    };
  }

  switch (specialist) {
    case "chat": {
      const g = gesture(t, 2.15);
      const side = g.cycle % 2 === 0 ? -1 : 1;
      const reach = clamp(g.action, 0, 1);

      chains[0] = {
        visible: true,
        from: { x: 100 + side * 45, y: 101 },
        control: {
          x: 100 + side * (58 + reach * 7),
          y: 94 - g.anticipation * 4,
        },
        to: {
          x: side < 0 ? 20 : 180,
          y: side < 0 ? 75 : 90,
        },
        thickness: 12 + reach * 2,
        tip: 9 + reach * 3,
      };

      return {
        body: {
          cx: 100 + side * reach * 7,
          cy: 101 - g.overshoot * 2,
          rx: 61 + reach * 2,
          ry: 54 - reach * 2,
          rotation: side * (2 + reach * 5),
        },
        chains,
        gaze: {
          x: side * (5 + reach * 4),
          y: -1,
          rotation: side * 3,
          scaleX: 1.03,
          scaleY: 1,
        },
      };
    }

    case "code": {
      const g = gesture(t, 2.35);
      const reach = clamp(g.action, 0, 1);
      const tapA = Math.max(0, wave(t, 13)) * reach;
      const tapB = Math.max(0, wave(t, 13, Math.PI)) * reach;

      chains[0] = {
        visible: true,
        from: { x: 77, y: 124 },
        control: { x: 66, y: 138 },
        to: { x: 70, y: 159 + tapA * 8 },
        thickness: 11,
        tip: 7.5,
      };

      chains[1] = {
        visible: true,
        from: { x: 123, y: 124 },
        control: { x: 134, y: 138 },
        to: { x: 128, y: 159 + tapB * 8 },
        thickness: 11,
        tip: 7.5,
      };

      return {
        body: {
          cx: 103 + reach * 2,
          cy: 108 + reach * 5,
          rx: 49 - reach * 3,
          ry: 66 + reach * 5,
          rotation: 5 + reach * 4,
        },
        chains,
        gaze: {
          x: 2,
          y: 6 + reach * 5,
          rotation: 3,
          scaleX: .97,
          scaleY: .90,
        },
      };
    }

    case "data": {
      const g = gesture(t, 2.7);
      const reach = clamp(g.action, 0, 1);

      const targets = [
        { x: 136, y: 127 },
        { x: 150, y: 106 },
        { x: 169, y: 76 },
        { x: 184, y: 87 },
      ];
      const target = targets[g.cycle % targets.length]!;

      chains[0] = {
        visible: true,
        from: { x: 125, y: 78 },
        control: {
          x: 143,
          y: 87 - reach * 11,
        },
        to: {
          x: lerp(132, target.x, reach),
          y: lerp(94, target.y, reach),
        },
        thickness: 10.5,
        tip: 8.5,
      };

      return {
        body: {
          cx: 97,
          cy: 96 - reach * 4,
          rx: 48 - reach * 2,
          ry: 68 + reach * 8,
          rotation: -4 + reach * 3,
        },
        chains,
        gaze: {
          x: 4 + reach * 4,
          y: -3 - reach * 3,
          rotation: -2,
          scaleX: .97,
          scaleY: 1.04,
        },
      };
    }

    case "design": {
      const g = gesture(t, 2.55);
      const reach = clamp(g.action, 0, 1);
      const side = g.cycle % 2 === 0 ? 1 : -1;

      chains[0] = {
        visible: true,
        from: { x: 100 + side * 42, y: 110 },
        control: {
          x: 100 + side * (54 + reach * 18),
          y: 101 - reach * 11,
        },
        to: {
          x: side > 0 ? 169 : 31,
          y: 87 + wave(t, 1.7) * 12,
        },
        thickness: 11.5,
        tip: 8.5,
      };

      return {
        body: {
          cx: 100 + side * reach * 3,
          cy: 99,
          rx: 59,
          ry: 57,
          rotation: -5 + side * reach * 8,
        },
        chains,
        gaze: {
          x: side * (3 + reach * 5),
          y: 0,
          rotation: side * 4,
          scaleX: 1.03,
          scaleY: .96,
        },
      };
    }

    case "agent": {
      const g = gesture(t, 2.95);
      const reach = clamp(g.action, 0, 1);
      const endpoints = [
        { x: 36, y: 52 },
        { x: 164, y: 52 },
        { x: 36, y: 151 },
        { x: 164, y: 151 },
      ];
      const starts = [
        { x: 72, y: 76 },
        { x: 128, y: 76 },
        { x: 72, y: 124 },
        { x: 128, y: 124 },
      ];

      for (let i = 0; i < MAX_CHAINS; i++) {
        const stagger = clamp(reach - i * .06, 0, 1);
        const start = starts[i]!;
        const end = endpoints[i]!;

        chains[i] = {
          visible: true,
          from: start,
          control: {
            x: lerp(start.x, end.x, .52),
            y: lerp(start.y, end.y, .44),
          },
          to: {
            x: lerp(start.x, end.x, stagger),
            y: lerp(start.y, end.y, stagger),
          },
          thickness: 9.5,
          tip: 6 + stagger * 4.5,
          detach: stagger > .86 ? (stagger - .86) / .14 : 0,
        };
      }

      return {
        body: {
          cx: 100,
          cy: 101 - g.overshoot * 2,
          rx: 61 - reach * 3,
          ry: 54 + reach * 3,
          rotation: g.overshoot * 2,
        },
        chains,
        gaze: {
          x: 0,
          y: -2,
          rotation: 0,
          scaleX: 1.04,
          scaleY: .94,
        },
      };
    }

    case "flow": {
      const g = gesture(t, 2.45);
      const reach = clamp(g.action, 0, 1);
      const direction = g.cycle % 2 === 0 ? 1 : -1;

      chains[0] = {
        visible: true,
        from: {
          x: 100 + direction * 48,
          y: 103,
        },
        control: {
          x: 100 + direction * 69,
          y: 89,
        },
        to: {
          x: 100 + direction * lerp(56, 86, reach),
          y: 111 - reach * 10,
        },
        thickness: 13,
        tip: 10,
      };

      chains[1] = {
        visible: true,
        from: {
          x: 100 - direction * 45,
          y: 107,
        },
        control: {
          x: 100 - direction * 58,
          y: 121,
        },
        to: {
          x: 100 - direction * (50 + g.anticipation * 12),
          y: 120,
        },
        thickness: 10,
        tip: 7,
      };

      return {
        body: {
          cx: 100 + direction * reach * 7,
          cy: 103,
          rx: 70 + reach * 12,
          ry: 41 - reach * 3,
          rotation: direction * reach * 3,
        },
        chains,
        gaze: {
          x: direction * (4 + reach * 5),
          y: 1,
          rotation: direction * 2,
          scaleX: 1.08,
          scaleY: .94,
        },
      };
    }

    case "tuning": {
      const g = gesture(t, 2.3);
      const reach = clamp(g.action, 0, 1);
      const active = g.cycle % 3;
      const knobX = [57, 101, 146];
      const knobY = [148, 164, 180];
      const starts = [
        { x: 73, y: 125 },
        { x: 100, y: 130 },
        { x: 127, y: 125 },
      ];

      for (let i = 0; i < 3; i++) {
        const isActive = i === active;
        const amount = isActive ? reach : .12;

        chains[i] = {
          visible: isActive || amount > .10,
          from: starts[i]!,
          control: {
            x: lerp(starts[i]!.x, knobX[i]!, .52),
            y: 139,
          },
          to: {
            x: lerp(starts[i]!.x, knobX[i]!, amount),
            y: lerp(starts[i]!.y, knobY[i]!, amount),
          },
          thickness: isActive ? 10.5 : 8,
          tip: isActive ? 7.5 : 5.5,
        };
      }

      return {
        body: {
          cx: 100,
          cy: 105 + reach * 3,
          rx: 55,
          ry: 61,
          rotation: (active - 1) * reach * 3,
        },
        chains,
        gaze: {
          x: (active - 1) * (3 + reach * 3),
          y: 5,
          rotation: (active - 1) * 2,
          scaleX: .98,
          scaleY: .92,
        },
      };
    }

    case "security": {
      const g = gesture(t, 2.8);
      const reach = clamp(g.action, 0, 1);

      // Two short shoulder lobes + one long lower tip merge into a shield.
      chains[0] = {
        visible: true,
        from: { x: 61, y: 88 },
        control: { x: 49, y: 91 },
        to: { x: 42 - reach * 6, y: 99 },
        thickness: 14,
        tip: 11,
      };

      chains[1] = {
        visible: true,
        from: { x: 139, y: 88 },
        control: { x: 151, y: 91 },
        to: { x: 158 + reach * 6, y: 99 },
        thickness: 14,
        tip: 11,
      };

      chains[2] = {
        visible: true,
        from: { x: 100, y: 143 },
        control: { x: 100, y: 158 },
        to: { x: 100, y: 165 + reach * 17 },
        thickness: 13,
        tip: 8,
      };

      return {
        body: {
          cx: 100,
          cy: 104,
          rx: 65 + reach * 7,
          ry: 49 + reach * 2,
          rotation: 0,
        },
        chains,
        gaze: {
          x: 0,
          y: 1,
          rotation: 0,
          scaleX: 1.08,
          scaleY: .88,
        },
      };
    }
  }
};

const appendLine = (
  parent: SVGElement,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  color: string,
  width = 2,
  opacity = 1,
): SVGLineElement => {
  const node = makeSvg("line", {
    x1,
    y1,
    x2,
    y2,
    stroke: color,
    "stroke-width": width,
    "stroke-linecap": "round",
    opacity,
  });
  parent.appendChild(node);
  return node;
};

const appendCircle = (
  parent: SVGElement,
  cx: number,
  cy: number,
  r: number,
  color: string,
  opacity = 1,
): SVGCircleElement => {
  const node = makeSvg("circle", { cx, cy, r, fill: color, opacity });
  parent.appendChild(node);
  return node;
};

const appendRect = (
  parent: SVGElement,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
  color: string,
  fill: string,
  opacity = 1,
): SVGRectElement => {
  const node = makeSvg("rect", {
    x,
    y,
    width: w,
    height: h,
    rx: radius,
    stroke: color,
    "stroke-width": 1.4,
    fill,
    opacity,
  });
  parent.appendChild(node);
  return node;
};

const appendPath = (
  parent: SVGElement,
  d: string,
  color: string,
  width = 2,
  opacity = 1,
): SVGPathElement => {
  const node = makeSvg("path", {
    d,
    fill: "none",
    stroke: color,
    "stroke-width": width,
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    opacity,
  });
  parent.appendChild(node);
  return node;
};

/**
 * Props are intentionally sparse. They must not become the identity of the card.
 * The black creature is the actor; props only give context to its gesture.
 */
const drawArtifacts = (
  scene: Scene,
  specialist: Specialist,
  state: SpecialistState,
  t: number,
  accent: string,
  bodyColor: string,
  detailed: boolean,
): void => {
  clear(scene.artifacts);

  if (state === "waiting") {
    if (!detailed) return;

    const z = makeSvg("text", {
      x: 151,
      y: 61,
      fill: accent,
      opacity: .44,
      "font-size": 12,
      "font-weight": 700,
    });
    z.textContent = "Z";
    scene.artifacts.appendChild(z);
    return;
  }

  if (state !== "working" || !detailed) return;

  switch (specialist) {
    case "chat": {
      const g = gesture(t, 2.15);
      const side = g.cycle % 2 === 0 ? -1 : 1;
      const x = side < 0 ? 5 : 160;
      const y = side < 0 ? 63 : 78;

      appendRect(
        scene.artifacts,
        x,
        y,
        35,
        22,
        9,
        accent,
        `${accent}0b`,
        .56,
      );

      [0, 1, 2].forEach((i) =>
        appendCircle(
          scene.artifacts,
          x + 11 + i * 7,
          y + 11,
          1.3 + clamp(g.action, 0, 1) * .5,
          accent,
          .72,
        ),
      );
      break;
    }

    case "code": {
      // Low-profile keyboard/terminal directly underneath the two black fingertips.
      appendRect(
        scene.artifacts,
        47,
        153,
        106,
        30,
        7,
        accent,
        "#070809",
        .66,
      );
      appendLine(scene.artifacts, 57, 163, 80, 163, accent, 1.6, .62);
      appendLine(scene.artifacts, 57, 171, 95, 171, accent, 1.4, .28);
      break;
    }

    case "data": {
      const g = gesture(t, 2.7);
      const points = [
        { x: 135, y: 128 },
        { x: 151, y: 106 },
        { x: 170, y: 76 },
        { x: 184, y: 87 },
      ];

      appendPath(
        scene.artifacts,
        `M${points.map((p) => `${p.x} ${p.y}`).join(" L")}`,
        accent,
        1.5,
        .24,
      );

      points.forEach((p, index) => {
        const active = index === g.cycle % points.length;
        appendCircle(
          scene.artifacts,
          p.x,
          p.y,
          active ? 3.1 : 1.8,
          accent,
          active ? .88 : .38,
        );
      });
      break;
    }

    case "design": {
      const g = gesture(t, 2.55);
      const side = g.cycle % 2 === 0 ? 1 : -1;
      const reach = clamp(g.action, 0, 1);
      const tipX = side > 0 ? 169 : 31;
      const tipY = 87 + wave(t, 1.7) * 12;

      // Only the paint trail; no giant Bézier UI overlay.
      const startX = side > 0 ? 112 : 88;
      const startY = 128;
      const cX = lerp(startX, tipX, .55);
      const cY = 88 - reach * 8;

      appendPath(
        scene.artifacts,
        `M${startX} ${startY} Q${cX} ${cY} ${tipX} ${tipY}`,
        accent,
        2,
        .58,
      );
      appendCircle(scene.artifacts, tipX, tipY, 2.8, accent, .88);
      break;
    }

    case "agent": {
      const g = gesture(t, 2.95);
      const endpoints = [
        { x: 36, y: 52 },
        { x: 164, y: 52 },
        { x: 36, y: 151 },
        { x: 164, y: 151 },
      ];

      endpoints.forEach((end, index) => {
        const stagger = clamp(clamp(g.action, 0, 1) - index * .06, 0, 1);
        if (stagger < .72) return;

        const alpha = clamp((stagger - .72) / .28, 0, 1);
        const r = 4.5 + alpha * 3.5;

        appendCircle(scene.artifacts, end.x, end.y, r, bodyColor, .75);
        appendCircle(scene.artifacts, end.x - 1.6, end.y - .5, .65, "#fff", .84);
        appendCircle(scene.artifacts, end.x + 1.6, end.y - .5, .65, "#fff", .84);
      });
      break;
    }

    case "flow": {
      const g = gesture(t, 2.45);
      const direction = g.cycle % 2 === 0 ? 1 : -1;
      const x = 100 + direction * lerp(58, 88, clamp(g.action, 0, 1));
      const y = 111 - clamp(g.action, 0, 1) * 10;

      const nodes = [
        { x: 22, y: 126 },
        { x: 59, y: 109 },
        { x: 141, y: 136 },
        { x: 178, y: 105 },
      ];

      nodes.forEach((n) => {
        const c = appendCircle(scene.artifacts, n.x, n.y, 3.8, `${accent}10`, .65);
        c.setAttribute("stroke", accent);
        c.setAttribute("stroke-width", "1.2");
      });

      appendCircle(scene.artifacts, x, y, 3.0, accent, .90);
      break;
    }

    case "tuning": {
      const g = gesture(t, 2.3);
      const active = g.cycle % 3;
      const ys = [148, 164, 180];
      const xs = [57, 101, 146];

      ys.forEach((y, index) => {
        appendLine(scene.artifacts, 40, y, 160, y, accent, 1, .18);
        appendCircle(
          scene.artifacts,
          xs[index]!,
          y,
          index === active ? 4.1 : 3.0,
          accent,
          index === active ? .78 : .34,
        );
      });
      break;
    }

    case "security": {
      const g = gesture(t, 2.8);
      const q = clamp(g.action, 0, 1);
      const y = lerp(78, 153, q);
      const half = 31 + Math.sin(q * Math.PI) * 22;

      appendLine(scene.artifacts, 100 - half, y, 100 + half, y, accent, 1.7, .78);
      appendCircle(scene.artifacts, 100 + half, y, 2.8, accent, .88);
      break;
    }
  }
};

const createSpring = (value: number): Spring => ({
  value,
  velocity: 0,
});

const springStep = (
  spring: Spring,
  target: number,
  dt: number,
  stiffness = 245,
  damping = 24,
): void => {
  const force = (target - spring.value) * stiffness;
  spring.velocity += force * dt;
  spring.velocity *= Math.exp(-damping * dt);
  spring.value += spring.velocity * dt;
};

type Tickable = { tick(now: number): void };
const ACTIVE = new Set<Tickable>();
let RAF = 0;

const rafLoop = (now: number): void => {
  for (const item of [...ACTIVE]) item.tick(now);
  if (ACTIVE.size) RAF = requestAnimationFrame(rafLoop);
  else RAF = 0;
};

const register = (item: Tickable): void => {
  ACTIVE.add(item);
  if (!RAF) RAF = requestAnimationFrame(rafLoop);
};

const unregister = (item: Tickable): void => {
  ACTIVE.delete(item);
  if (!ACTIVE.size && RAF) {
    cancelAnimationFrame(RAF);
    RAF = 0;
  }
};

class Controller implements ProfessionalGrokController, Tickable {
  readonly element: HTMLElement;

  private readonly module: AvatarLabModule;
  private readonly avatar: AvatarLabInstance;
  private readonly avatarHost: HTMLDivElement;
  private readonly scene: Scene;
  private readonly detailed: boolean;
  private readonly reduceMotion: boolean;

  private specialist: Specialist;
  private state: SpecialistState;
  private accent: string;
  private bodyColor: string;
  private deformation: number;

  private eyesRoot: SVGGElement | null = null;

  private body = {
    cx: createSpring(100),
    cy: createSpring(100),
    rx: createSpring(58),
    ry: createSpring(58),
    rotation: createSpring(0),
  };

  private gaze = {
    x: createSpring(0),
    y: createSpring(0),
    rotation: createSpring(0),
    scaleX: createSpring(1),
    scaleY: createSpring(1),
  };

  private chainPoints: SpringPoint[][] = Array.from(
    { length: MAX_CHAINS },
    () =>
      Array.from({ length: NODES_PER_CHAIN }, () => ({
        x: createSpring(100),
        y: createSpring(100),
      })),
  );

  private chainRadii: Spring[][] = Array.from(
    { length: MAX_CHAINS },
    () =>
      Array.from({ length: NODES_PER_CHAIN }, () => createSpring(.01)),
  );

  private started = performance.now();
  private lastNow = performance.now();
  private paused = false;
  private destroyed = false;

  constructor(params: {
    element: HTMLElement;
    module: AvatarLabModule;
    avatar: AvatarLabInstance;
    avatarHost: HTMLDivElement;
    scene: Scene;
    specialist: Specialist;
    state: SpecialistState;
    accent: string;
    bodyColor: string;
    deformation: number;
    detailed: boolean;
  }) {
    this.element = params.element;
    this.module = params.module;
    this.avatar = params.avatar;
    this.avatarHost = params.avatarHost;
    this.scene = params.scene;
    this.specialist = params.specialist;
    this.state = params.state;
    this.accent = params.accent;
    this.bodyColor = params.bodyColor;
    this.deformation = params.deformation;
    this.detailed = params.detailed;

    this.reduceMotion =
      typeof matchMedia !== "undefined" &&
      matchMedia("(prefers-reduced-motion: reduce)").matches;

    this.eyesRoot =
      this.avatarHost.querySelector<SVGGElement>('[data-grok-eyes-root="true"]');

    this.hideOriginalBody();
    this.syncIdentity();
    this.playEmotion();
    register(this);
  }

  getSpecialist(): Specialist {
    return this.specialist;
  }

  getState(): SpecialistState {
    return this.state;
  }

  setSpecialist(specialist: Specialist): void {
    if (specialist === this.specialist) return;

    this.specialist = specialist;
    this.accent = SPECIALIST_ACCENT[specialist];
    this.started = performance.now();
    this.syncIdentity();
    this.playEmotion();
  }

  setState(state: SpecialistState): void {
    if (state === this.state) return;

    this.state = state;
    this.started = performance.now();
    this.syncIdentity();
    this.playEmotion();
  }

  setAccent(color: string): void {
    this.accent = color;
    this.scene.root.style.setProperty("--gmv7-accent", color);
  }

  setDeformation(strength: number): void {
    this.deformation = clamp(strength, .45, 1.65);
  }

  pause(): void {
    this.paused = true;
    this.avatar.pause();
  }

  resume(): void {
    this.paused = false;
    this.lastNow = performance.now();
    this.playEmotion();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    unregister(this);
    this.avatar.destroy?.();
    this.scene.root.remove();
  }

  tick(now: number): void {
    if (this.destroyed || this.paused) return;

    const dt = clamp((now - this.lastNow) / 1000, 0, .05);
    this.lastNow = now;

    const t = this.reduceMotion ? .82 : (now - this.started) / 1000;
    const target = rigFor(this.specialist, this.state, t);

    this.stepBody(target.body, dt);
    this.stepGaze(target.gaze, dt);
    this.stepChains(target.chains, dt);

    this.renderBody();
    this.renderChains();
    this.renderGaze();

    drawArtifacts(
      this.scene,
      this.specialist,
      this.state,
      t,
      this.accent,
      this.bodyColor,
      this.detailed,
    );
  }

  private syncIdentity(): void {
    this.scene.root.dataset.specialist = this.specialist;
    this.scene.root.dataset.state = this.state;
    this.scene.root.style.setProperty("--gmv7-accent", this.accent);
    this.scene.root.style.setProperty("--gmv7-body", this.bodyColor);
    this.scene.root.setAttribute(
      "aria-label",
      `${SPECIALIST_LABEL[this.specialist]} — ${STATE_LABEL[this.state]}`,
    );
  }

  private hideOriginalBody(): void {
    const hide = (selector: string): void => {
      this.avatarHost.querySelectorAll<SVGElement>(selector).forEach((node) => {
        node.style.opacity = "0";
        node.style.pointerEvents = "none";
      });
    };

    hide('[data-grok-body-shape="true"]');
    hide('[data-grok-body-highlight="true"]');
    hide('[data-grok-shadow="true"]');
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

  private stepBody(target: BodyPose, dt: number): void {
    const k = this.state === "working" ? 270 : 210;
    const d = this.state === "working" ? 22 : 25;

    springStep(this.body.cx, target.cx, dt, k, d);
    springStep(this.body.cy, target.cy, dt, k, d);
    springStep(this.body.rx, target.rx, dt, k, d);
    springStep(this.body.ry, target.ry, dt, k, d);
    springStep(this.body.rotation, target.rotation, dt, k, d);
  }

  private stepGaze(target: RigPose["gaze"], dt: number): void {
    springStep(this.gaze.x, target.x, dt, 320, 27);
    springStep(this.gaze.y, target.y, dt, 320, 27);
    springStep(this.gaze.rotation, target.rotation, dt, 320, 27);
    springStep(this.gaze.scaleX, target.scaleX, dt, 320, 27);
    springStep(this.gaze.scaleY, target.scaleY, dt, 320, 27);
  }

  private stepChains(chains: ChainPose[], dt: number): void {
    for (let chainIndex = 0; chainIndex < MAX_CHAINS; chainIndex++) {
      const chain = chains[chainIndex] ?? hiddenChain();

      for (let nodeIndex = 0; nodeIndex < NODES_PER_CHAIN; nodeIndex++) {
        const p = nodeIndex / (NODES_PER_CHAIN - 1);
        const point = chain.visible
          ? bezier(chain.from, chain.control, chain.to, p)
          : { x: this.body.cx.value, y: this.body.cy.value };

        const radius =
          chain.visible
            ? lerp(chain.thickness, chain.tip, p) *
              (1 - (chain.detach ?? 0) * Math.max(0, .65 - p))
            : .01;

        const springPoint = this.chainPoints[chainIndex]![nodeIndex]!;
        const springRadius = this.chainRadii[chainIndex]![nodeIndex]!;

        springStep(springPoint.x, point.x, dt, 300, 24);
        springStep(springPoint.y, point.y, dt, 300, 24);
        springStep(springRadius, radius, dt, 300, 25);
      }
    }
  }

  private renderBody(): void {
    const { cx, cy, rx, ry, rotation } = this.body;

    this.scene.bodyEllipse.setAttribute("cx", cx.value.toFixed(2));
    this.scene.bodyEllipse.setAttribute("cy", cy.value.toFixed(2));
    this.scene.bodyEllipse.setAttribute(
      "rx",
      (rx.value * this.deformation).toFixed(2),
    );
    this.scene.bodyEllipse.setAttribute(
      "ry",
      (ry.value * this.deformation).toFixed(2),
    );
    this.scene.bodyEllipse.setAttribute(
      "transform",
      `rotate(${rotation.value.toFixed(2)} ${cx.value.toFixed(2)} ${cy.value.toFixed(2)})`,
    );

    // Highlight is smaller and follows the main body only, keeping the body readable as one mass.
    this.scene.bodyGlow.setAttribute("cx", cx.value.toFixed(2));
    this.scene.bodyGlow.setAttribute("cy", cy.value.toFixed(2));
    this.scene.bodyGlow.setAttribute(
      "rx",
      (Math.max(8, rx.value * this.deformation - 3)).toFixed(2),
    );
    this.scene.bodyGlow.setAttribute(
      "ry",
      (Math.max(8, ry.value * this.deformation - 3)).toFixed(2),
    );
    this.scene.bodyGlow.setAttribute(
      "transform",
      `rotate(${rotation.value.toFixed(2)} ${cx.value.toFixed(2)} ${cy.value.toFixed(2)})`,
    );

    this.scene.shadow.setAttribute("cx", cx.value.toFixed(2));
    this.scene.shadow.setAttribute(
      "cy",
      Math.min(190, cy.value + ry.value * .92 + 14).toFixed(2),
    );
    this.scene.shadow.setAttribute(
      "rx",
      clamp(rx.value * .78, 26, 70).toFixed(2),
    );
    this.scene.shadow.setAttribute(
      "ry",
      (this.state === "waiting" ? 5.3 : 6.8).toFixed(2),
    );
  }

  private renderChains(): void {
    for (let chainIndex = 0; chainIndex < MAX_CHAINS; chainIndex++) {
      for (let nodeIndex = 0; nodeIndex < NODES_PER_CHAIN; nodeIndex++) {
        const point = this.chainPoints[chainIndex]![nodeIndex]!;
        const radius = this.chainRadii[chainIndex]![nodeIndex]!;
        const node = this.scene.chainNodes[chainIndex]![nodeIndex]!;

        node.setAttribute("cx", point.x.value.toFixed(2));
        node.setAttribute("cy", point.y.value.toFixed(2));
        node.setAttribute(
          "r",
          Math.max(.01, radius.value * this.deformation).toFixed(2),
        );
      }
    }
  }

  private renderGaze(): void {
    if (!this.eyesRoot) return;

    const x = this.gaze.x.value / EYE_COORD_SCALE;
    const y = this.gaze.y.value / EYE_COORD_SCALE;

    this.eyesRoot.setAttribute(
      "transform",
      `translate(${x.toFixed(2)} ${y.toFixed(2)}) ` +
        `rotate(${this.gaze.rotation.value.toFixed(2)} 0 0) ` +
        `scale(${this.gaze.scaleX.value.toFixed(3)} ${this.gaze.scaleY.value.toFixed(3)})`,
    );
  }
}

export async function mountProfessionalGrokAvatar(
  target: Element | string,
  options: MountProfessionalGrokOptions,
): Promise<ProfessionalGrokController> {
  if (typeof window === "undefined" || typeof document === "undefined") {
    throw new Error(
      "mountProfessionalGrokAvatar() must run in the browser/client runtime.",
    );
  }

  ensureStyles();

  const element = resolveTarget(target);
  const module = await loadModule(options.moduleUrl);

  const specialist = options.specialist;
  const state = options.state ?? "active";
  const accent = options.accent ?? SPECIALIST_ACCENT[specialist];
  const bodyColor = options.bodyColor ?? "#020203";
  const size = options.size ?? 240;
  const deformation = clamp(options.deformation ?? 1, .45, 1.65);
  const statusCues = options.statusCues ?? true;

  const numericSize =
    typeof size === "number" ? size : Number.parseFloat(String(size)) || 220;

  const detailed = numericSize >= 150;

  const scene = createScene(size, bodyColor, accent, statusCues);

  const avatarHost = document.createElement("div");
  avatarHost.className = "gmv7-avatar";
  scene.root.insertBefore(avatarHost, scene.artSvg);
  element.appendChild(scene.root);

  const animation = pickAnimation(
    module.availableAnimations,
    specialist,
    state,
  );

  const avatar = module.createAvatar(avatarHost, {
    animation,
    size: "100%",
    autoplay: false,
  });

  return new Controller({
    element,
    module,
    avatar,
    avatarHost,
    scene,
    specialist,
    state,
    accent,
    bodyColor,
    deformation,
    detailed,
  });
}

export function professionalVisualStateFromRuntime(input: {
  isOwner?: boolean;
  completed?: boolean;
  status?: string | null;
}): SpecialistState {
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
 * O catálogo de animações por especialista e estado.
 *
 * Exportado porque é CONTRATO: o teste percorre os 8 x 5 e falha se alguma
 * combinação ficar sem animação. Um buraco aqui não quebra nada em execução —
 * `pickAnimation` cai no fallback — e por isso mesmo precisa de guarda: ele só
 * apareceria como um bot parado na tela.
 */
export const PROFESSIONAL_GROK_BEHAVIOR_MAP = ANIMATION_CANDIDATES;
export const GROK_SPECIALIST_BEHAVIOR_MAP = ANIMATION_CANDIDATES;
