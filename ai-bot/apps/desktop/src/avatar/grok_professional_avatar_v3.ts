/**
 * grok_professional_avatar_v3.ts
 *
 * V5 — morphing professional creature.
 *
 * Keeps the public filename/API used by the project, but replaces the old
 * "round avatar + external professional icon" approach.
 *
 * Main idea:
 * - Avatar Lab / grok-avatar.js still owns the white eyes / emotional playback.
 * - The original round body is hidden.
 * - A single organic black SVG silhouette is rendered underneath the eyes.
 * - That SAME silhouette continuously morphs into the professional gesture.
 * - No robot body. No fixed round ball with badges.
 *
 * Working semantics:
 *   chat     -> body reaches toward alternating conversation bubbles
 *   code     -> body crouches over terminal and grows two typing pseudopods
 *   data     -> body stretches toward the active data point
 *   design   -> body grows one elastic lobe that drags a Bézier handle
 *   agent    -> body buds / dispatches small child agents
 *   flow     -> body becomes a horizontal flowing amoeba following a packet
 *   tuning   -> body grows pseudopods toward live slider knobs
 *   security -> body becomes shield-like while a scan sweeps through it
 *
 * Five states:
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

type Lobe = {
  angle: number;
  width: number;
  amount: number;
};

type ShapeTarget = {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  rotation: number;
  flattenTop?: number;
  flattenBottom?: number;
  lobes: Lobe[];
};

type Scene = {
  root: HTMLDivElement;
  bodySvg: SVGSVGElement;
  artifactSvg: SVGSVGElement;
  bodyPath: SVGPathElement;
  bodyHighlight: SVGPathElement;
  shadow: SVGEllipseElement;
  artifacts: SVGGElement;
  ownerRing: SVGCircleElement;
  ownerDots: SVGCircleElement[];
  completeGroup: SVGGElement;
};

const SVG_NS = "http://www.w3.org/2000/svg";
const TAU = Math.PI * 2;
const POINTS = 56;

const clamp = (v: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, v));

const lerp = (a: number, b: number, t: number): number =>
  a + (b - a) * t;

const wave = (t: number, speed = 1, phase = 0): number =>
  Math.sin(t * speed + phase);

const sin01 = (t: number, speed = 1, phase = 0): number =>
  0.5 + 0.5 * wave(t, speed, phase);

const pingPong = (t: number): number => {
  const p = ((t % 2) + 2) % 2;
  return p <= 1 ? p : 2 - p;
};

const ease = (t: number): number => {
  const p = clamp(t, 0, 1);
  return p * p * (3 - 2 * p);
};

const angleDistance = (a: number, b: number): number => {
  let d = Math.abs(a - b) % TAU;
  if (d > Math.PI) d = TAU - d;
  return d;
};

const gaussian = (angle: number, center: number, width: number): number => {
  const d = angleDistance(angle, center);
  return Math.exp(-(d * d) / (2 * width * width));
};

const makeSvg = <K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
): SVGElementTagNameMap[K] => {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
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
  code: "Code",
  data: "Data",
  design: "Design",
  agent: "Agent",
  flow: "Fluxo",
  tuning: "Tuning",
  security: "Security",
};

const STATE_LABEL: Record<SpecialistState, string> = {
  active: "Ativo",
  owner: "Owner",
  working: "Trabalhando",
  waiting: "Em espera",
  completed: "Concluído",
};

export const ANIMATIONS: Record<
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

  for (const candidate of ANIMATIONS[specialist][state]) {
    if (set.has(candidate)) return candidate;
  }

  for (const fallback of ["idle", "listening", "thinking", "working", "sleeping"]) {
    if (set.has(fallback)) return fallback;
  }

  return available[0];
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

const resolveTarget = (target: Element | string): HTMLElement => {
  const node =
    typeof target === "string" ? document.querySelector(target) : target;

  if (!(node instanceof HTMLElement)) {
    throw new Error(`Professional Grok target not found: ${String(target)}`);
  }

  return node;
};

const ensureStyles = (): void => {
  if (document.getElementById("professional-grok-v5-style")) return;

  const style = document.createElement("style");
  style.id = "professional-grok-v5-style";
  style.textContent = `
.pgv5-root {
  --pgv5-size: 240px;
  --pgv5-accent: #55c7ff;
  --pgv5-body: #050506;
  position: relative;
  width: var(--pgv5-size);
  height: var(--pgv5-size);
  overflow: visible;
  isolation: isolate;
  user-select: none;
  -webkit-user-select: none;
}

.pgv5-body-svg,
.pgv5-artifact-svg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: visible;
  pointer-events: none;
}

.pgv5-body-svg { z-index: 2; }
.pgv5-artifact-svg { z-index: 4; }

.pgv5-avatar {
  position: absolute;
  inset: 11%;
  z-index: 3;
  display: grid;
  place-items: center;
  pointer-events: none;
}

.pgv5-avatar > * {
  width: 100% !important;
  height: 100% !important;
}

.pgv5-owner-ring {
  fill: none;
  stroke: var(--pgv5-accent);
  stroke-width: 1.4;
  stroke-dasharray: 9 8;
  opacity: 0;
  transform-origin: 100px 100px;
}

.pgv5-root[data-state="owner"] .pgv5-owner-ring {
  opacity: .55;
  animation: pgv5-owner-spin 9s linear infinite;
}

.pgv5-owner-dot {
  fill: var(--pgv5-accent);
  opacity: 0;
}

.pgv5-root[data-state="owner"] .pgv5-owner-dot {
  opacity: .85;
  animation: pgv5-owner-dot 2s ease-in-out infinite;
}

.pgv5-complete {
  color: var(--pgv5-accent);
  opacity: 0;
  transform-origin: 170px 170px;
}

.pgv5-root[data-state="completed"] .pgv5-complete {
  opacity: .95;
  animation: pgv5-complete 2.4s ease-in-out infinite;
}

@keyframes pgv5-owner-spin {
  to { transform: rotate(360deg); }
}

@keyframes pgv5-owner-dot {
  0%,100% { transform: scale(.72); opacity: .35; }
  50% { transform: scale(1.18); opacity: 1; }
}

@keyframes pgv5-complete {
  0%,70%,100% { transform: scale(.94); opacity: .65; }
  82% { transform: scale(1.12); opacity: 1; }
}

@media (prefers-reduced-motion: reduce) {
  .pgv5-root * {
    animation-duration: 1ms !important;
    animation-iteration-count: 1 !important;
  }
}
`;
  document.head.appendChild(style);
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
  const line = makeSvg("line", {
    x1,
    y1,
    x2,
    y2,
    stroke: color,
    "stroke-width": width,
    "stroke-linecap": "round",
    opacity,
  });
  parent.appendChild(line);
  return line;
};

const appendCircle = (
  parent: SVGElement,
  cx: number,
  cy: number,
  r: number,
  color: string,
  opacity = 1,
): SVGCircleElement => {
  const circle = makeSvg("circle", { cx, cy, r, fill: color, opacity });
  parent.appendChild(circle);
  return circle;
};

const appendPath = (
  parent: SVGElement,
  d: string,
  color: string,
  width = 2,
  fill = "none",
  opacity = 1,
): SVGPathElement => {
  const path = makeSvg("path", {
    d,
    stroke: color,
    "stroke-width": width,
    fill,
    opacity,
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
  });
  parent.appendChild(path);
  return path;
};

const appendRect = (
  parent: SVGElement,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
  color: string,
  fill = "none",
  opacity = 1,
): SVGRectElement => {
  const rect = makeSvg("rect", {
    x,
    y,
    width,
    height,
    rx: radius,
    stroke: color,
    "stroke-width": 1.7,
    fill,
    opacity,
  });
  parent.appendChild(rect);
  return rect;
};

const createScene = (
  size: number | string,
  bodyColor: string,
  accent: string,
  statusCues: boolean,
): Scene => {
  const root = document.createElement("div");
  root.className = "pgv5-root";
  root.style.setProperty(
    "--pgv5-size",
    typeof size === "number" ? `${size}px` : size,
  );
  root.style.setProperty("--pgv5-body", bodyColor);
  root.style.setProperty("--pgv5-accent", accent);

  const bodySvg = makeSvg("svg", {
    class: "pgv5-body-svg",
    viewBox: "0 0 200 200",
    "aria-hidden": "true",
  });

  const defs = makeSvg("defs");
  const gradId = `pgv5-grad-${Math.random().toString(36).slice(2)}`;
  const gradient = makeSvg("radialGradient", {
    id: gradId,
    cx: "34%",
    cy: "25%",
    r: "82%",
  });
  gradient.append(
    makeSvg("stop", { offset: "0%", "stop-color": "#25262a" }),
    makeSvg("stop", { offset: "42%", "stop-color": "#09090a" }),
    makeSvg("stop", { offset: "100%", "stop-color": bodyColor }),
  );
  defs.appendChild(gradient);
  bodySvg.appendChild(defs);

  const shadow = makeSvg("ellipse", {
    cx: 100,
    cy: 166,
    rx: 52,
    ry: 8,
    fill: "#000",
    opacity: .28,
  });

  const bodyPath = makeSvg("path", {
    // Marcada para o teste poder afirmar que ELA é que deforma. Sem o gancho,
    // a única forma de checar seria pela posição no SVG — que muda a cada
    // rearranjo e daria teste verde por acidente.
    "data-pgv5-silhouette": "true",
    fill: `url(#${gradId})`,
    stroke: "#2c2d31",
    "stroke-width": 1.05,
  });

  const bodyHighlight = makeSvg("path", {
    fill: "none",
    stroke: "#fff",
    "stroke-width": 1.1,
    opacity: .10,
    "stroke-linecap": "round",
  });

  bodySvg.append(shadow, bodyPath, bodyHighlight);

  const artifactSvg = makeSvg("svg", {
    class: "pgv5-artifact-svg",
    viewBox: "0 0 200 200",
    "aria-hidden": "true",
  });

  const artifacts = makeSvg("g");
  artifactSvg.appendChild(artifacts);

  const ownerRing = makeSvg("circle", {
    class: "pgv5-owner-ring",
    cx: 100,
    cy: 100,
    r: 88,
  });
  artifactSvg.appendChild(ownerRing);

  const ownerDots = [
    makeSvg("circle", {
      class: "pgv5-owner-dot",
      cx: 84,
      cy: 14,
      r: 2.1,
    }),
    makeSvg("circle", {
      class: "pgv5-owner-dot",
      cx: 100,
      cy: 9,
      r: 2.8,
      style: "animation-delay:180ms",
    }),
    makeSvg("circle", {
      class: "pgv5-owner-dot",
      cx: 116,
      cy: 14,
      r: 2.1,
      style: "animation-delay:360ms",
    }),
  ];
  ownerDots.forEach((dot) => artifactSvg.appendChild(dot));

  const completeGroup = makeSvg("g", {
    class: "pgv5-complete",
    transform: "translate(170 170)",
  });
  completeGroup.append(
    makeSvg("circle", {
      cx: 0,
      cy: 0,
      r: 15,
      fill: "none",
      stroke: "currentColor",
      "stroke-width": 1.4,
      opacity: .32,
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
  artifactSvg.appendChild(completeGroup);

  if (!statusCues) {
    ownerRing.style.display = "none";
    ownerDots.forEach((dot) => (dot.style.display = "none"));
    completeGroup.style.display = "none";
  }

  root.append(bodySvg, artifactSvg);

  return {
    root,
    bodySvg,
    artifactSvg,
    bodyPath,
    bodyHighlight,
    shadow,
    artifacts,
    ownerRing,
    ownerDots,
    completeGroup,
  };
};

/**
 * Converts closed points into one continuously smooth cubic path.
 * The body therefore morphs as one creature instead of swapping shapes.
 */
const closedSpline = (points: readonly Point[]): string => {
  if (points.length < 3) return "";

  const n = points.length;
  let d = `M${points[0]!.x.toFixed(2)} ${points[0]!.y.toFixed(2)}`;

  for (let i = 0; i < n; i++) {
    const p0 = points[(i - 1 + n) % n]!;
    const p1 = points[i]!;
    const p2 = points[(i + 1) % n]!;
    const p3 = points[(i + 2) % n]!;

    const c1 = {
      x: p1.x + (p2.x - p0.x) / 6,
      y: p1.y + (p2.y - p0.y) / 6,
    };
    const c2 = {
      x: p2.x - (p3.x - p1.x) / 6,
      y: p2.y - (p3.y - p1.y) / 6,
    };

    d +=
      ` C${c1.x.toFixed(2)} ${c1.y.toFixed(2)}` +
      ` ${c2.x.toFixed(2)} ${c2.y.toFixed(2)}` +
      ` ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
  }

  return `${d} Z`;
};

const baseShape = (
  specialist: Specialist,
  state: SpecialistState,
  t: number,
): ShapeTarget => {
  if (state === "waiting") {
    return {
      cx: 100,
      cy: 118 + wave(t, .75) * .8,
      rx: 68,
      ry: 37,
      rotation: -4,
      flattenTop: 5,
      flattenBottom: 7,
      lobes: [
        { angle: Math.PI, width: .60, amount: 5 },
        { angle: 0, width: .60, amount: 8 },
      ],
    };
  }

  if (state === "completed") {
    const pop = Math.max(0, wave(t, 1.9));
    return {
      cx: 100,
      cy: 99 - pop * 1.5,
      rx: 59 + pop * 2.8,
      ry: 58 + pop * 3.6,
      rotation: wave(t, .9) * 1.2,
      lobes: [],
    };
  }

  const owner = state === "owner" ? 1 : 0;
  const working = state === "working";
  const breathe = wave(t, state === "active" ? 1.15 : .9);

  const generic: ShapeTarget = {
    cx: 100 + wave(t, .7) * .6,
    cy: 100 + wave(t, .95, .6) * .7 - owner * 3,
    rx: 58 + breathe * 1.2 + owner * 2.5,
    ry: 58 - breathe * .8 + owner * 2.5,
    rotation: wave(t, .65) * 1.1,
    lobes: [],
  };

  switch (specialist) {
    case "chat":
      return {
        ...generic,
        rx: generic.rx + 4,
        ry: generic.ry - 2,
        rotation: -2 + generic.rotation,
        lobes: working
          ? [
              {
                angle: Math.PI,
                width: .42,
                amount: 10 + sin01(t, 2.3) * 15,
              },
              {
                angle: 0,
                width: .42,
                amount: 10 + sin01(t, 2.3, Math.PI) * 15,
              },
            ]
          : [
              { angle: Math.PI, width: .52, amount: 4 },
              { angle: 0, width: .52, amount: 4 },
            ],
      };

    case "code": {
      const typing = working ? Math.abs(wave(t, 9.5)) : 0;
      return {
        ...generic,
        cy: generic.cy + 7,
        rx: generic.rx - 7,
        ry: generic.ry + 8,
        rotation: 5 + generic.rotation,
        flattenTop: 3,
        lobes: [
          {
            angle: .98,
            width: .25,
            amount: working ? 17 + typing * 9 : 4,
          },
          {
            angle: 2.16,
            width: .25,
            amount: working
              ? 17 + Math.abs(wave(t, 9.5, Math.PI)) * 9
              : 4,
          },
          {
            angle: -.18,
            width: .48,
            amount: working ? 8 : 2,
          },
        ],
      };
    }

    case "data": {
      const progress = working ? pingPong(t * .72) : .45;
      const targetX = lerp(128, 170, progress);
      const targetY = lerp(107, 58, progress);
      const angle = Math.atan2(targetY - 100, targetX - 100);

      return {
        ...generic,
        cx: generic.cx - 3,
        cy: generic.cy - 3,
        rx: generic.rx - 9,
        ry: generic.ry + 10,
        rotation: -4 + generic.rotation,
        lobes: [
          {
            angle,
            width: .30,
            amount: working ? 20 + sin01(t, 3) * 8 : 6,
          },
          { angle: Math.PI / 2, width: .40, amount: 5 },
        ],
      };
    }

    case "design": {
      const handleX = 148 + wave(t, 1.45) * 14;
      const handleY = 124 + wave(t, 1.15, 1.1) * 18;
      const angle = Math.atan2(handleY - 98, handleX - 100);

      return {
        ...generic,
        rx: generic.rx + 2,
        ry: generic.ry + 1,
        rotation: -8 + wave(t, 1.2) * 5,
        lobes: [
          {
            angle,
            width: .25,
            amount: working ? 31 + sin01(t, 2.6) * 8 : 7,
          },
          {
            angle: angle + Math.PI,
            width: .52,
            amount: working ? 8 : 3,
          },
        ],
      };
    }

    case "agent": {
      const lobes: Lobe[] = [];
      const angles = [-2.45, -.70, .70, 2.45];

      angles.forEach((angle, i) => {
        lobes.push({
          angle,
          width: .28,
          amount: working
            ? 12 + sin01(t, 2.0, i * 1.4) * 17
            : 4 + owner * 4,
        });
      });

      return {
        ...generic,
        rx: generic.rx + 4,
        ry: generic.ry - 4,
        lobes,
      };
    }

    case "flow": {
      const direction = working ? pingPong(t * .86) * 2 - 1 : 0;
      return {
        ...generic,
        cx: generic.cx + direction * 3.5,
        rx: generic.rx + 18 + Math.abs(direction) * 8,
        ry: generic.ry - 16,
        rotation: direction * 2,
        lobes: [
          {
            angle: direction >= 0 ? 0 : Math.PI,
            width: .38,
            amount: working ? 18 : 5,
          },
          {
            angle: direction >= 0 ? Math.PI : 0,
            width: .50,
            amount: working ? 6 : 3,
          },
        ],
      };
    }

    case "tuning": {
      const a = working ? sin01(t, 2.5) : .5;
      const b = working ? sin01(t, 2.9, 1.8) : .5;
      return {
        ...generic,
        cy: generic.cy + 5,
        rx: generic.rx - 2,
        ry: generic.ry + 2,
        lobes: [
          {
            angle: 1.05,
            width: .24,
            amount: working ? 12 + a * 14 : 4,
          },
          {
            angle: 1.58,
            width: .22,
            amount: working ? 10 + (1 - a) * 13 : 3,
          },
          {
            angle: 2.10,
            width: .24,
            amount: working ? 12 + b * 14 : 4,
          },
        ],
      };
    }

    case "security": {
      const brace = working
        ? Math.sin(pingPong(t * 1.05) * Math.PI)
        : 0;

      return {
        ...generic,
        cy: generic.cy + 4,
        rx: generic.rx + 8 + brace * 5,
        ry: generic.ry - 4 + brace * 2,
        flattenTop: 7,
        flattenBottom: -8,
        lobes: [
          {
            angle: Math.PI / 2,
            width: .22,
            amount: working ? 21 + brace * 5 : 12,
          },
          {
            angle: .12,
            width: .50,
            amount: working ? 8 + brace * 5 : 5,
          },
          {
            angle: Math.PI - .12,
            width: .50,
            amount: working ? 8 + brace * 5 : 5,
          },
        ],
      };
    }
  }
};

const targetPoints = (
  shape: ShapeTarget,
  deformation: number,
): Point[] => {
  const points: Point[] = [];
  const rotation = (shape.rotation * Math.PI) / 180;
  const cosR = Math.cos(rotation);
  const sinR = Math.sin(rotation);

  for (let i = 0; i < POINTS; i++) {
    const angle = (i / POINTS) * TAU - Math.PI / 2;

    let radiusDelta = 0;
    for (const lobe of shape.lobes) {
      radiusDelta += gaussian(angle, lobe.angle, lobe.width) * lobe.amount;
    }

    // Top/bottom flattening shapes are applied as controlled vertical pressure.
    let x = Math.cos(angle) * (shape.rx + radiusDelta * deformation);
    let y = Math.sin(angle) * (shape.ry + radiusDelta * deformation);

    const top = Math.max(0, -Math.sin(angle));
    const bottom = Math.max(0, Math.sin(angle));

    if (shape.flattenTop) {
      y += top * shape.flattenTop * deformation;
    }

    if (shape.flattenBottom) {
      y -= bottom * shape.flattenBottom * deformation;
    }

    const xr = x * cosR - y * sinR;
    const yr = x * sinR + y * cosR;

    points.push({
      x: shape.cx + xr,
      y: shape.cy + yr,
    });
  }

  return points;
};

const highlightPath = (points: readonly Point[]): string => {
  // Use the upper-left arc of the actual morphed body.
  const start = Math.floor(POINTS * .82);
  const end = Math.floor(POINTS * .98);
  const segment: Point[] = [];

  for (let i = start; i <= end; i++) {
    segment.push(points[i % POINTS]!);
  }

  if (segment.length < 2) return "";

  return (
    `M${segment[0]!.x.toFixed(2)} ${segment[0]!.y.toFixed(2)} ` +
    segment
      .slice(1)
      .map((p) => `L${p.x.toFixed(2)} ${p.y.toFixed(2)}`)
      .join(" ")
  );
};

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

    const z1 = makeSvg("text", {
      x: 151,
      y: 59,
      fill: accent,
      opacity: .55,
      "font-size": 12,
      "font-weight": 700,
    });
    z1.textContent = "Z";
    scene.artifacts.appendChild(z1);

    const z2 = makeSvg("text", {
      x: 165,
      y: 43,
      fill: accent,
      opacity: .27,
      "font-size": 9,
      "font-weight": 700,
    });
    z2.textContent = "z";
    scene.artifacts.appendChild(z2);
    return;
  }

  if (state === "completed" || !detailed) return;

  const working = state === "working";
  const alpha = working ? 1 : .45;

  switch (specialist) {
    case "chat": {
      const left = sin01(t, 2.3) > .5;

      appendRect(
        scene.artifacts,
        7,
        58,
        38,
        25,
        10,
        accent,
        left ? `${accent}12` : "none",
        left ? .86 : .28,
      );
      appendRect(
        scene.artifacts,
        155,
        76,
        38,
        25,
        10,
        accent,
        !left ? `${accent}12` : "none",
        !left ? .86 : .28,
      );

      const dots = left
        ? [[19, 70], [27, 70], [35, 70]]
        : [[167, 88], [175, 88], [183, 88]];

      dots.forEach(([x, y], i) =>
        appendCircle(
          scene.artifacts,
          x!,
          y!,
          1.3 + sin01(t, 6.2, i * .75) * 1.2,
          accent,
          .8,
        ),
      );
      break;
    }

    case "code": {
      // Terminal directly touches the typing lobes.
      appendRect(
        scene.artifacts,
        46,
        148,
        108,
        38,
        7,
        accent,
        "#070809",
        .82 * alpha,
      );
      appendLine(scene.artifacts, 55, 159, 78, 159, accent, 2, .78 * alpha);
      appendLine(scene.artifacts, 55, 168, 96, 168, accent, 2, .38 * alpha);
      appendLine(scene.artifacts, 55, 177, 74, 177, accent, 2, .55 * alpha);

      const cursor = 82 + pingPong(t * 2.25) * 53;
      appendLine(scene.artifacts, cursor, 157, cursor, 170, accent, 2, .95);
      break;
    }

    case "data": {
      const points = [
        { x: 118, y: 138 },
        { x: 132, y: 123 },
        { x: 145, y: 129 },
        { x: 157, y: 96 },
        { x: 171, y: 70 },
        { x: 186, y: 81 },
      ];

      appendPath(
        scene.artifacts,
        `M${points.map((p) => `${p.x} ${p.y}`).join(" L")}`,
        accent,
        2,
        "none",
        .48 * alpha,
      );

      points.forEach((p) =>
        appendCircle(scene.artifacts, p.x, p.y, 2.4, accent, .65 * alpha),
      );

      if (working) {
        const p = pingPong(t * .72);
        const scaled = p * (points.length - 1);
        const i = Math.min(points.length - 2, Math.floor(scaled));
        const local = scaled - i;
        const a = points[i]!;
        const b = points[i + 1]!;
        const x = lerp(a.x, b.x, local);
        const y = lerp(a.y, b.y, local);
        appendCircle(scene.artifacts, x, y, 5.4, accent, .18);
        appendCircle(scene.artifacts, x, y, 2.2, accent, .96);
      }
      break;
    }

    case "design": {
      const c1 = {
        x: 59 + wave(t, 1.45) * 9,
        y: 66 + wave(t, 1.1) * 10,
      };
      const c2 = {
        x: 148 + wave(t, 1.45) * 14,
        y: 124 + wave(t, 1.15, 1.1) * 18,
      };

      appendPath(
        scene.artifacts,
        `M25 153 C${c1.x} ${c1.y} ${c2.x} ${c2.y} 178 91`,
        accent,
        2,
        "none",
        .76 * alpha,
      );

      appendLine(scene.artifacts, 25, 153, c1.x, c1.y, accent, 1, .22 * alpha);
      appendLine(scene.artifacts, 178, 91, c2.x, c2.y, accent, 1, .22 * alpha);
      appendCircle(scene.artifacts, c1.x, c1.y, 2.5, accent, .6 * alpha);
      appendCircle(scene.artifacts, c2.x, c2.y, 4.2, accent, .88 * alpha);
      break;
    }

    case "agent": {
      const angles = [-2.45, -.70, .70, 2.45];

      angles.forEach((angle, i) => {
        const dispatch = working ? sin01(t, 2.0, i * 1.4) : .25;
        const radius = 68 + dispatch * 30;
        const x = 100 + Math.cos(angle) * radius;
        const y = 100 + Math.sin(angle) * radius * .76;

        appendLine(
          scene.artifacts,
          100,
          100,
          x,
          y,
          accent,
          1,
          .10 + dispatch * .18,
        );

        // Child agent is still "blob language": black body + two tiny white eyes.
        appendCircle(
          scene.artifacts,
          x,
          y,
          4 + dispatch * 4,
          bodyColor,
          .58 + dispatch * .35,
        );
        appendCircle(scene.artifacts, x - 1.7, y - .5, .75, "#fff", .86);
        appendCircle(scene.artifacts, x + 1.7, y - .5, .75, "#fff", .86);
      });
      break;
    }

    case "flow": {
      const nodes = [
        { x: 18, y: 132 },
        { x: 57, y: 109 },
        { x: 143, y: 137 },
        { x: 184, y: 105 },
      ];

      appendPath(
        scene.artifacts,
        `M${nodes.map((n) => `${n.x} ${n.y}`).join(" L")}`,
        accent,
        1.7,
        "none",
        .28 * alpha,
      );

      nodes.forEach((n, i) => {
        if (i === 1 || i === 2) {
          scene.artifacts.appendChild(
            makeSvg("path", {
              d: `M${n.x} ${n.y - 6} L${n.x + 6} ${n.y} L${n.x} ${n.y + 6} L${n.x - 6} ${n.y} Z`,
              fill: `${accent}10`,
              stroke: accent,
              "stroke-width": 1.6,
              opacity: .65 * alpha,
            }),
          );
        } else {
          const c = appendCircle(
            scene.artifacts,
            n.x,
            n.y,
            5.4,
            `${accent}12`,
            .8 * alpha,
          );
          c.setAttribute("stroke", accent);
          c.setAttribute("stroke-width", "1.5");
        }
      });

      if (working) {
        const p = (t * .48) % 1;
        const scaled = p * (nodes.length - 1);
        const i = Math.min(nodes.length - 2, Math.floor(scaled));
        const local = ease(scaled - i);
        const a = nodes[i]!;
        const b = nodes[i + 1]!;
        const x = lerp(a.x, b.x, local);
        const y = lerp(a.y, b.y, local);
        appendCircle(scene.artifacts, x, y, 7, accent, .10);
        appendCircle(scene.artifacts, x, y, 3.6, accent, .92);
      }
      break;
    }

    case "tuning": {
      const rows = [145, 162, 179];
      const phases = [0, 1.7, 3.4];

      rows.forEach((y, i) => {
        appendLine(scene.artifacts, 34, y, 166, y, accent, 1.2, .28 * alpha);
        const x =
          55 + sin01(t, working ? 2.5 + i * .35 : .5, phases[i]!) * 90;
        appendCircle(scene.artifacts, x, y, 4.6, accent, .82 * alpha);
      });
      break;
    }

    case "security": {
      // Scanner goes THROUGH the body so the body itself is the protected object.
      const p = working ? pingPong(t * 1.05) : .35;
      const y = lerp(76, 152, p);
      const half = 32 + Math.sin(p * Math.PI) * 24;

      appendLine(scene.artifacts, 100 - half, y, 100 + half, y, accent, 2, .88);
      appendCircle(scene.artifacts, 100 + half, y, 3.5, accent, .92);
      break;
    }
  }
};

type Tickable = {
  tick(now: number): void;
};

const ACTIVE = new Set<Tickable>();
let sharedRaf = 0;

const sharedLoop = (now: number): void => {
  for (const item of [...ACTIVE]) item.tick(now);
  if (ACTIVE.size) sharedRaf = requestAnimationFrame(sharedLoop);
  else sharedRaf = 0;
};

const registerTicker = (item: Tickable): void => {
  ACTIVE.add(item);
  if (!sharedRaf) sharedRaf = requestAnimationFrame(sharedLoop);
};

const unregisterTicker = (item: Tickable): void => {
  ACTIVE.delete(item);
  if (!ACTIVE.size && sharedRaf) {
    cancelAnimationFrame(sharedRaf);
    sharedRaf = 0;
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

  private currentPoints: Point[] = [];
  private lastNow = performance.now();
  private started = performance.now();
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

    this.syncIdentity();
    this.hideRoundSourceBody();
    this.playEmotion();

    const initialShape = baseShape(
      this.specialist,
      this.state,
      this.reduceMotion ? .8 : 0,
    );
    this.currentPoints = targetPoints(initialShape, this.deformation);
    this.renderBody();

    registerTicker(this);
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
    this.syncIdentity();
    this.playEmotion();
  }

  setState(state: SpecialistState): void {
    if (state === this.state) return;
    this.state = state;
    this.syncIdentity();
    this.playEmotion();
  }

  setAccent(color: string): void {
    this.accent = color;
    this.scene.root.style.setProperty("--pgv5-accent", color);
  }

  setDeformation(strength: number): void {
    this.deformation = clamp(strength, 0, 1.65);
  }

  pause(): void {
    this.paused = true;
    this.avatar.pause();
  }

  resume(): void {
    this.paused = false;
    this.lastNow = performance.now();
    this.avatar.play(
      pickAnimation(
        this.module.availableAnimations,
        this.specialist,
        this.state,
      ),
    );
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    unregisterTicker(this);
    this.avatar.destroy?.();
    this.scene.root.remove();
  }

  tick(now: number): void {
    if (this.destroyed || this.paused) return;

    const dt = clamp((now - this.lastNow) / 1000, 0, .08);
    this.lastNow = now;

    const elapsed = this.reduceMotion ? .8 : (now - this.started) / 1000;
    const shape = baseShape(this.specialist, this.state, elapsed);
    const target = targetPoints(shape, this.deformation);

    const response = this.reduceMotion ? 1 : 1 - Math.exp(-dt * 10.5);

    if (this.currentPoints.length !== target.length) {
      this.currentPoints = target.map((p) => ({ ...p }));
    } else {
      for (let i = 0; i < target.length; i++) {
        const current = this.currentPoints[i]!;
        const next = target[i]!;
        current.x = lerp(current.x, next.x, response);
        current.y = lerp(current.y, next.y, response);
      }
    }

    this.renderBody();

    drawArtifacts(
      this.scene,
      this.specialist,
      this.state,
      elapsed,
      this.accent,
      this.bodyColor,
      this.detailed,
    );
  }

  private syncIdentity(): void {
    this.scene.root.dataset.specialist = this.specialist;
    this.scene.root.dataset.state = this.state;
    this.scene.root.style.setProperty("--pgv5-accent", this.accent);
    this.scene.root.style.setProperty("--pgv5-body", this.bodyColor);
    this.scene.root.setAttribute(
      "aria-label",
      `${SPECIALIST_LABEL[this.specialist]} — ${STATE_LABEL[this.state]}`,
    );
  }

  private hideRoundSourceBody(): void {
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

  private renderBody(): void {
    const d = closedSpline(this.currentPoints);
    this.scene.bodyPath.setAttribute("d", d);
    this.scene.bodyHighlight.setAttribute(
      "d",
      highlightPath(this.currentPoints),
    );

    let minX = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const p of this.currentPoints) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }

    const width = Math.max(25, maxX - minX);
    this.scene.shadow.setAttribute("cx", "100");
    this.scene.shadow.setAttribute("cy", String(Math.min(184, maxY + 10)));
    this.scene.shadow.setAttribute(
      "rx",
      String(clamp(width * .38, 28, 70)),
    );
    this.scene.shadow.setAttribute(
      "ry",
      String(this.state === "waiting" ? 6.5 : 7.5),
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
  const deformation = clamp(options.deformation ?? 1, 0, 1.65);
  const statusCues = options.statusCues ?? true;

  const numericSize =
    typeof size === "number" ? size : Number.parseFloat(String(size)) || 220;

  // Full professional props are only useful at a size where the eye can read them.
  // Smaller avatars still get the same body morph + emotional state.
  const detailed = numericSize >= 160;

  const scene = createScene(size, bodyColor, accent, statusCues);

  const avatarHost = document.createElement("div");
  avatarHost.className = "pgv5-avatar";

  scene.root.insertBefore(avatarHost, scene.artifactSvg);
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
 * Exportado porque é CONTRATO, não detalhe: o teste percorre os 8 x 5 e falha se
 * alguma combinação ficar sem animação. Um estado sem entrada não quebra nada em
 * execução — o `pickAnimation` cai no fallback — e é exatamente por isso que
 * precisa de guarda: o buraco só apareceria como um bot parado na tela.
 */
export const PROFESSIONAL_GROK_BEHAVIOR_MAP = ANIMATIONS;
export const GROK_SPECIALIST_BEHAVIOR_MAP = ANIMATIONS;
