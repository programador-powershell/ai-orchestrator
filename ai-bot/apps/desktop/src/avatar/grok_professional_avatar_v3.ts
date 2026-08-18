/**
 * grok_professional_avatar_v3.ts
 *
 * V6 — Grok-like elastic choreography.
 *
 * This keeps the public filename/API already used by the project.
 *
 * What changed from V5:
 * - no more "continuous sine-wave screensaver" as the main motion;
 * - each specialist now has a choreographed action cycle:
 *     anticipation -> action -> overshoot -> settle -> hold;
 * - the SAME black body morphs into the professional gesture;
 * - the eyes follow the mass and the task target;
 * - external props are secondary and only support the gesture;
 * - waiting collapses, Owner rises, completed rebounds.
 *
 * Avatar Lab / grok-avatar.js still supplies the white-eye emotional playback.
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
  topPressure?: number;
  bottomPressure?: number;
  lobes: Lobe[];
};

type Gesture = {
  p: number;
  cycle: number;
  reach: number;
  anticipation: number;
  overshoot: number;
  settle: number;
  action: number;
};

type Gaze = {
  x: number;
  y: number;
  rotate: number;
  scaleX: number;
  scaleY: number;
};

type Scene = {
  root: HTMLDivElement;
  bodySvg: SVGSVGElement;
  artifactSvg: SVGSVGElement;
  bodyPath: SVGPathElement;
  highlightPath: SVGPathElement;
  shadow: SVGEllipseElement;
  artifacts: SVGGElement;
  ownerRing: SVGCircleElement;
  ownerDots: SVGCircleElement[];
  completeGroup: SVGGElement;
};

const SVG_NS = "http://www.w3.org/2000/svg";
const TAU = Math.PI * 2;
const POINT_COUNT = 64;
const EYE_COORD_SCALE = 0.709; // 156px host / 220 viewBox at a 200 unit stage.

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

  for (const name of ANIMATION_CANDIDATES[specialist][state]) {
    if (set.has(name)) return name;
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
    throw new Error(`Grok professional avatar target not found: ${String(target)}`);
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
  if (document.getElementById("grok-professional-v6-style")) return;

  const style = document.createElement("style");
  style.id = "grok-professional-v6-style";
  style.textContent = `
.gpv6-root {
  --gpv6-size: 240px;
  --gpv6-accent: #55c7ff;
  --gpv6-body: #020203;
  position: relative;
  width: var(--gpv6-size);
  height: var(--gpv6-size);
  overflow: visible;
  isolation: isolate;
  user-select: none;
  -webkit-user-select: none;
}

.gpv6-body-svg,
.gpv6-art-svg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: visible;
  pointer-events: none;
}

.gpv6-body-svg { z-index: 2; }
.gpv6-art-svg { z-index: 4; }

.gpv6-avatar {
  position: absolute;
  inset: 11%;
  z-index: 3;
  display: grid;
  place-items: center;
  pointer-events: none;
}

.gpv6-avatar > * {
  width: 100% !important;
  height: 100% !important;
}

.gpv6-owner-ring {
  fill: none;
  stroke: var(--gpv6-accent);
  stroke-width: 1.35;
  stroke-dasharray: 8 9;
  opacity: 0;
  transform-origin: 100px 100px;
}

.gpv6-root[data-state="owner"] .gpv6-owner-ring {
  opacity: .43;
  animation: gpv6-owner-spin 10s linear infinite;
}

.gpv6-owner-dot {
  fill: var(--gpv6-accent);
  opacity: 0;
}

.gpv6-root[data-state="owner"] .gpv6-owner-dot {
  opacity: .8;
  animation: gpv6-owner-dot 2.1s ease-in-out infinite;
}

.gpv6-complete {
  color: var(--gpv6-accent);
  opacity: 0;
  transform-origin: 171px 171px;
}

.gpv6-root[data-state="completed"] .gpv6-complete {
  opacity: .95;
  animation: gpv6-complete 2.7s ease-in-out infinite;
}

@keyframes gpv6-owner-spin {
  to { transform: rotate(360deg); }
}

@keyframes gpv6-owner-dot {
  0%,100% { opacity: .28; transform: scale(.72); }
  50% { opacity: 1; transform: scale(1.14); }
}

@keyframes gpv6-complete {
  0%,70%,100% { opacity: .62; transform: scale(.94); }
  82% { opacity: 1; transform: scale(1.13); }
}

@media (prefers-reduced-motion: reduce) {
  .gpv6-root * {
    animation-duration: 1ms !important;
    animation-iteration-count: 1 !important;
  }
}
`;

  document.head.appendChild(style);
};

/**
 * Grok-like action beat.
 *
 * The negative anticipation and >1 overshoot are what make the action feel
 * intentional instead of a continuous procedural wobble.
 */
const gesture = (t: number, period: number, phase = 0): Gesture => {
  const raw = t / period + phase;
  const cycle = Math.floor(raw);
  const p = raw - cycle;

  let reach = 0;
  let anticipation = 0;
  let overshoot = 0;
  let settle = 0;

  if (p < 0.14) {
    anticipation = smoother(p / 0.14);
    reach = -0.18 * anticipation;
  } else if (p < 0.38) {
    const q = smoother((p - 0.14) / 0.24);
    anticipation = 1 - q;
    reach = lerp(-0.18, 1, q);
  } else if (p < 0.50) {
    const q = smooth((p - 0.38) / 0.12);
    overshoot = q;
    reach = lerp(1, 1.14, q);
  } else if (p < 0.72) {
    const q = smoother((p - 0.50) / 0.22);
    overshoot = 1 - q;
    settle = q;
    reach = lerp(1.14, 0.76, q);
  } else {
    const q = smoother((p - 0.72) / 0.28);
    settle = 1 - q;
    reach = lerp(0.76, 0.14, q);
  }

  const action = clamp((reach + 0.18) / 1.32, 0, 1);

  return { p, cycle, reach, anticipation, overshoot, settle, action };
};

const bodyGradient = (
  id: string,
  bodyColor: string,
): SVGDefsElement => {
  const defs = makeSvg("defs");
  const gradient = makeSvg("radialGradient", {
    id,
    cx: "33%",
    cy: "22%",
    r: "84%",
  });

  gradient.append(
    makeSvg("stop", { offset: "0%", "stop-color": "#292a2e" }),
    makeSvg("stop", { offset: "38%", "stop-color": "#0a0a0b" }),
    makeSvg("stop", { offset: "100%", "stop-color": bodyColor }),
  );

  defs.appendChild(gradient);
  return defs;
};

const createScene = (
  size: number | string,
  bodyColor: string,
  accent: string,
  statusCues: boolean,
): Scene => {
  const root = document.createElement("div");
  root.className = "gpv6-root";
  root.style.setProperty(
    "--gpv6-size",
    typeof size === "number" ? `${size}px` : size,
  );
  root.style.setProperty("--gpv6-accent", accent);
  root.style.setProperty("--gpv6-body", bodyColor);

  const bodySvg = makeSvg("svg", {
    class: "gpv6-body-svg",
    viewBox: "0 0 200 200",
    "aria-hidden": "true",
  });

  const gradientId = `gpv6-body-${Math.random().toString(36).slice(2)}`;
  bodySvg.appendChild(bodyGradient(gradientId, bodyColor));

  const shadow = makeSvg("ellipse", {
    cx: 100,
    cy: 170,
    rx: 46,
    ry: 7,
    fill: "#000",
    opacity: .24,
  });

  const bodyPath = makeSvg("path", {
    // Gancho de teste. Sem ele, a única forma de achar a silhueta seria pela
    // POSIÇÃO no SVG — que muda a cada rearranjo e daria verde por acidente no
    // dia seguinte. É o terceiro pacote seguido que o remove; se sumir de novo,
    // reponha antes de rodar os testes.
    "data-grok-silhouette": "true",
    fill: `url(#${gradientId})`,
    stroke: "#2c2d31",
    "stroke-width": 1.05,
  });

  const highlightPath = makeSvg("path", {
    fill: "none",
    stroke: "#fff",
    "stroke-width": 1,
    "stroke-linecap": "round",
    opacity: .09,
  });

  bodySvg.append(shadow, bodyPath, highlightPath);

  const artifactSvg = makeSvg("svg", {
    class: "gpv6-art-svg",
    viewBox: "0 0 200 200",
    "aria-hidden": "true",
  });

  const artifacts = makeSvg("g");
  artifactSvg.appendChild(artifacts);

  const ownerRing = makeSvg("circle", {
    class: "gpv6-owner-ring",
    cx: 100,
    cy: 100,
    r: 88,
  });
  artifactSvg.appendChild(ownerRing);

  const ownerDots = [
    makeSvg("circle", {
      class: "gpv6-owner-dot",
      cx: 84,
      cy: 14,
      r: 2,
    }),
    makeSvg("circle", {
      class: "gpv6-owner-dot",
      cx: 100,
      cy: 9,
      r: 2.7,
      style: "animation-delay:180ms",
    }),
    makeSvg("circle", {
      class: "gpv6-owner-dot",
      cx: 116,
      cy: 14,
      r: 2,
      style: "animation-delay:360ms",
    }),
  ];
  ownerDots.forEach((dot) => artifactSvg.appendChild(dot));

  const completeGroup = makeSvg("g", {
    class: "gpv6-complete",
    transform: "translate(171 171)",
  });
  completeGroup.append(
    makeSvg("circle", {
      cx: 0,
      cy: 0,
      r: 15,
      fill: "none",
      stroke: "currentColor",
      "stroke-width": 1.3,
      opacity: .30,
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
    highlightPath,
    shadow,
    artifacts,
    ownerRing,
    ownerDots,
    completeGroup,
  };
};

const closedSpline = (points: readonly Point[]): string => {
  const n = points.length;
  if (n < 3) return "";

  let d = `M${points[0]!.x.toFixed(2)} ${points[0]!.y.toFixed(2)}`;

  for (let i = 0; i < n; i++) {
    const p0 = points[(i - 1 + n) % n]!;
    const p1 = points[i]!;
    const p2 = points[(i + 1) % n]!;
    const p3 = points[(i + 2) % n]!;

    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;

    d +=
      ` C${c1x.toFixed(2)} ${c1y.toFixed(2)}` +
      ` ${c2x.toFixed(2)} ${c2y.toFixed(2)}` +
      ` ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
  }

  return `${d} Z`;
};

const pointsFromShape = (
  shape: ShapeTarget,
  deformation: number,
): Point[] => {
  const rotation = (shape.rotation * Math.PI) / 180;
  const cosR = Math.cos(rotation);
  const sinR = Math.sin(rotation);
  const points: Point[] = [];

  for (let i = 0; i < POINT_COUNT; i++) {
    const angle = (i / POINT_COUNT) * TAU - Math.PI / 2;

    let lobe = 0;
    for (const item of shape.lobes) {
      lobe += gaussian(angle, item.angle, item.width) * item.amount * deformation;
    }

    let x = Math.cos(angle) * (shape.rx + lobe);
    let y = Math.sin(angle) * (shape.ry + lobe);

    const top = Math.max(0, -Math.sin(angle));
    const bottom = Math.max(0, Math.sin(angle));

    if (shape.topPressure) y += top * shape.topPressure * deformation;
    if (shape.bottomPressure) y -= bottom * shape.bottomPressure * deformation;

    const xr = x * cosR - y * sinR;
    const yr = x * sinR + y * cosR;

    points.push({ x: shape.cx + xr, y: shape.cy + yr });
  }

  return points;
};

const activeBase = (
  state: SpecialistState,
  t: number,
): ShapeTarget => {
  if (state === "waiting") {
    const breath = wave(t, .72);
    return {
      cx: 100,
      cy: 124 + breath * .7,
      rx: 70 + breath * .9,
      ry: 31 - breath * .4,
      rotation: -5,
      topPressure: 7,
      bottomPressure: 7,
      lobes: [
        { angle: Math.PI, width: .58, amount: 8 },
        { angle: 0, width: .58, amount: 11 },
      ],
    };
  }

  if (state === "completed") {
    const g = gesture(t, 2.8);
    const pop = g.p < .50 ? g.action : Math.max(0, 1 - (g.p - .5) * 2);
    return {
      cx: 100,
      cy: 99 - pop * 4,
      rx: 58 + pop * 5,
      ry: 58 + pop * 6,
      rotation: g.overshoot * 4 - g.anticipation * 2,
      lobes: [
        { angle: -.55, width: .40, amount: pop * 4 },
        { angle: Math.PI + .35, width: .45, amount: pop * 3 },
      ],
    };
  }

  const owner = state === "owner" ? 1 : 0;
  const breathe = wave(t, 1.0);

  return {
    cx: 100 + wave(t, .53) * .55,
    cy: 100 - owner * 4 + wave(t, .77, .4) * .55,
    rx: 58 + breathe * .8 + owner * 2,
    ry: 58 - breathe * .55 + owner * 3,
    rotation: wave(t, .45) * .8,
    lobes: owner
      ? [
          { angle: -Math.PI / 2, width: .48, amount: 4.5 },
          { angle: -.2, width: .62, amount: 2 },
          { angle: Math.PI + .2, width: .62, amount: 2 },
        ]
      : [],
  };
};

const professionalShapeAndGaze = (
  specialist: Specialist,
  state: SpecialistState,
  t: number,
): { shape: ShapeTarget; gaze: Gaze } => {
  const base = activeBase(state, t);

  if (state !== "working") {
    const waiting = state === "waiting";

    return {
      shape: base,
      gaze: {
        x: 0,
        y: waiting ? 9 : state === "owner" ? -2 : 0,
        rotate: waiting ? -3 : 0,
        scaleX: waiting ? 1.08 : 1,
        scaleY: waiting ? .82 : 1,
      },
    };
  }

  switch (specialist) {
    case "chat": {
      const g = gesture(t, 2.05);
      const side = g.cycle % 2 === 0 ? -1 : 1;

      return {
        shape: {
          ...base,
          cx: 100 + side * g.reach * 7,
          cy: 101 + g.anticipation * 2 - g.overshoot * 2,
          rx: 62 + g.action * 4,
          ry: 55 - g.action * 3,
          rotation: side * (2 + g.reach * 7),
          lobes: [
            {
              angle: side > 0 ? 0 : Math.PI,
              width: .42,
              amount: 5 + g.action * 28,
            },
            {
              angle: side > 0 ? Math.PI : 0,
              width: .56,
              amount: 3 + g.anticipation * 7,
            },
          ],
        },
        gaze: {
          x: side * (4 + g.action * 4),
          y: -1,
          rotate: side * 3,
          scaleX: 1.02,
          scaleY: 1,
        },
      };
    }

    case "code": {
      const g = gesture(t, 2.25);
      const typing = Math.max(0, wave(t, 13));
      const typingB = Math.max(0, wave(t, 13, Math.PI));

      return {
        shape: {
          ...base,
          cx: 103 + g.reach * 3,
          cy: 107 + g.action * 6,
          rx: 51 - g.action * 4,
          ry: 67 + g.action * 6,
          rotation: 5 + g.reach * 6,
          topPressure: g.action * 3,
          lobes: [
            {
              angle: .93,
              width: .22,
              amount: 4 + g.action * 29 + typing * 7,
            },
            {
              angle: 2.21,
              width: .22,
              amount: 4 + g.action * 29 + typingB * 7,
            },
            {
              angle: .10,
              width: .42,
              amount: g.action * 8,
            },
          ],
        },
        gaze: {
          x: 2 + g.action * 3,
          y: 5 + g.action * 5,
          rotate: 3 + g.action * 3,
          scaleX: .98,
          scaleY: .90,
        },
      };
    }

    case "data": {
      const g = gesture(t, 2.6);
      const targetIndex = g.cycle % 4;
      const targets = [
        { x: 133, y: 124 },
        { x: 150, y: 101 },
        { x: 170, y: 71 },
        { x: 181, y: 83 },
      ];
      const target = targets[targetIndex]!;
      const angle = Math.atan2(target.y - 100, target.x - 100);

      return {
        shape: {
          ...base,
          cx: 97 + g.anticipation * -3 + g.action * 2,
          cy: 97 - g.action * 5,
          rx: 49 - g.action * 3,
          ry: 68 + g.action * 9,
          rotation: -4 + g.reach * 4,
          lobes: [
            {
              angle,
              width: .27,
              amount: 5 + g.action * 34,
            },
            {
              angle: angle + Math.PI,
              width: .50,
              amount: g.anticipation * 8,
            },
          ],
        },
        gaze: {
          x: 3 + g.action * 5,
          y: -2 - g.action * 4,
          rotate: -2,
          scaleX: .96,
          scaleY: 1.04,
        },
      };
    }

    case "design": {
      const g = gesture(t, 2.45);
      const side = g.cycle % 2 === 0 ? 1 : -1;
      const angle = side > 0 ? .55 : Math.PI - .55;

      return {
        shape: {
          ...base,
          cx: 100 + side * g.action * 4,
          cy: 99 + g.anticipation * 3 - g.overshoot * 2,
          rx: 59 + g.action * 2,
          ry: 58 + g.overshoot * 2,
          rotation: -6 + side * g.reach * 10,
          lobes: [
            {
              angle,
              width: .23,
              amount: 6 + g.action * 39,
            },
            {
              angle: angle + Math.PI,
              width: .50,
              amount: 3 + g.anticipation * 9,
            },
          ],
        },
        gaze: {
          x: side * (2 + g.action * 6),
          y: g.action * 2,
          rotate: side * 5,
          scaleX: 1.05,
          scaleY: .96,
        },
      };
    }

    case "agent": {
      const g = gesture(t, 2.8);
      const amount = 4 + g.action * 23;

      return {
        shape: {
          ...base,
          cx: 100,
          cy: 101 - g.overshoot * 3,
          rx: 62 + g.anticipation * 4 - g.action * 3,
          ry: 54 - g.anticipation * 2 + g.action * 3,
          rotation: g.reach * 3,
          lobes: [
            { angle: -2.42, width: .27, amount },
            { angle: -.72, width: .27, amount },
            { angle: .72, width: .27, amount },
            { angle: 2.42, width: .27, amount },
          ],
        },
        gaze: {
          x: 0,
          y: -2,
          rotate: 0,
          scaleX: 1 + g.action * .06,
          scaleY: .94,
        },
      };
    }

    case "flow": {
      const g = gesture(t, 2.35);
      const direction = g.cycle % 2 === 0 ? 1 : -1;

      return {
        shape: {
          ...base,
          cx: 100 + direction * g.reach * 8,
          cy: 102 + g.anticipation * 2,
          rx: 72 + g.action * 19,
          ry: 42 - g.action * 5,
          rotation: direction * g.reach * 4,
          lobes: [
            {
              angle: direction > 0 ? 0 : Math.PI,
              width: .36,
              amount: 6 + g.action * 29,
            },
            {
              angle: direction > 0 ? Math.PI : 0,
              width: .53,
              amount: 3 + g.anticipation * 10,
            },
          ],
        },
        gaze: {
          x: direction * (4 + g.action * 5),
          y: 1,
          rotate: direction * 2,
          scaleX: 1.08,
          scaleY: .94,
        },
      };
    }

    case "tuning": {
      const g = gesture(t, 2.2);
      const knob = g.cycle % 3;
      const angles = [2.14, 1.57, .99];

      return {
        shape: {
          ...base,
          cx: 100,
          cy: 105 + g.action * 4,
          rx: 56 - g.action * 2,
          ry: 61 + g.action * 3,
          rotation: (knob - 1) * g.reach * 4,
          lobes: angles.map((angle, index) => ({
            angle,
            width: .21,
            amount:
              index === knob
                ? 5 + g.action * 35
                : 4 + g.settle * 5,
          })),
        },
        gaze: {
          x: (knob - 1) * (3 + g.action * 3),
          y: 5,
          rotate: (knob - 1) * 3,
          scaleX: .98,
          scaleY: .92,
        },
      };
    }

    case "security": {
      const g = gesture(t, 2.7);
      const brace = g.action;

      return {
        shape: {
          ...base,
          cx: 100,
          cy: 104 + g.anticipation * 3 - g.overshoot * 2,
          rx: 66 + brace * 11,
          ry: 50 + brace * 4,
          rotation: 0,
          topPressure: 8 + brace * 3,
          bottomPressure: -13 - brace * 7,
          lobes: [
            {
              angle: Math.PI / 2,
              width: .19,
              amount: 16 + brace * 25,
            },
            {
              angle: .12,
              width: .46,
              amount: 7 + brace * 7,
            },
            {
              angle: Math.PI - .12,
              width: .46,
              amount: 7 + brace * 7,
            },
          ],
        },
        gaze: {
          x: 0,
          y: 1,
          rotate: 0,
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

const appendPath = (
  parent: SVGElement,
  d: string,
  color: string,
  width = 2,
  fill = "none",
  opacity = 1,
): SVGPathElement => {
  const node = makeSvg("path", {
    d,
    stroke: color,
    "stroke-width": width,
    fill,
    opacity,
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
  });
  parent.appendChild(node);
  return node;
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
  const node = makeSvg("rect", {
    x,
    y,
    width,
    height,
    rx: radius,
    stroke: color,
    "stroke-width": 1.55,
    fill,
    opacity,
  });
  parent.appendChild(node);
  return node;
};

const drawWorkingArtifacts = (
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
      y: 62,
      fill: accent,
      opacity: .48,
      "font-size": 12,
      "font-weight": 700,
    });
    z1.textContent = "Z";

    const z2 = makeSvg("text", {
      x: 165,
      y: 46,
      fill: accent,
      opacity: .23,
      "font-size": 9,
      "font-weight": 700,
    });
    z2.textContent = "z";

    scene.artifacts.append(z1, z2);
    return;
  }

  if (state !== "working" || !detailed) return;

  switch (specialist) {
    case "chat": {
      const g = gesture(t, 2.05);
      const side = g.cycle % 2 === 0 ? -1 : 1;

      const bubbles = side < 0
        ? [
            { x: 5, y: 60, active: true },
            { x: 158, y: 81, active: false },
          ]
        : [
            { x: 5, y: 60, active: false },
            { x: 158, y: 81, active: true },
          ];

      bubbles.forEach((bubble) => {
        appendRect(
          scene.artifacts,
          bubble.x,
          bubble.y,
          37,
          23,
          9,
          accent,
          bubble.active ? `${accent}10` : "none",
          bubble.active ? .72 : .18,
        );
      });

      const active = side < 0 ? { x: 16, y: 71 } : { x: 169, y: 92 };
      [0, 1, 2].forEach((i) => {
        appendCircle(
          scene.artifacts,
          active.x + i * 8,
          active.y,
          1.25 + g.action * .8,
          accent,
          .72,
        );
      });
      break;
    }

    case "code": {
      const g = gesture(t, 2.25);
      appendRect(
        scene.artifacts,
        44,
        151,
        112,
        35,
        7,
        accent,
        "#060708",
        .73,
      );
      appendLine(scene.artifacts, 54, 162, 80, 162, accent, 1.8, .68);
      appendLine(scene.artifacts, 54, 171, 96, 171, accent, 1.8, .31);
      appendLine(scene.artifacts, 54, 179, 74, 179, accent, 1.8, .44);

      const cursor = 82 + g.action * 49;
      appendLine(scene.artifacts, cursor, 160, cursor, 171, accent, 1.7, .9);
      break;
    }

    case "data": {
      const g = gesture(t, 2.6);
      const targetIndex = g.cycle % 4;
      const points = [
        { x: 124, y: 135 },
        { x: 139, y: 122 },
        { x: 151, y: 128 },
        { x: 163, y: 99 },
        { x: 174, y: 72 },
        { x: 188, y: 82 },
      ];

      appendPath(
        scene.artifacts,
        `M${points.map((p) => `${p.x} ${p.y}`).join(" L")}`,
        accent,
        1.7,
        "none",
        .34,
      );
      points.forEach((p) =>
        appendCircle(scene.artifacts, p.x, p.y, 2.0, accent, .52),
      );

      const focused = points[Math.min(points.length - 1, targetIndex + 2)]!;
      appendCircle(scene.artifacts, focused.x, focused.y, 5.2, accent, .12);
      appendCircle(scene.artifacts, focused.x, focused.y, 2.3, accent, .9);
      break;
    }

    case "design": {
      const g = gesture(t, 2.45);
      const side = g.cycle % 2 === 0 ? 1 : -1;
      const c1 = side > 0 ? { x: 62, y: 66 } : { x: 49, y: 116 };
      const c2 =
        side > 0
          ? { x: 151 + g.action * 12, y: 122 - g.action * 12 }
          : { x: 42 - g.action * 10, y: 92 - g.action * 7 };

      appendPath(
        scene.artifacts,
        `M24 154 C${c1.x} ${c1.y} ${c2.x} ${c2.y} 178 91`,
        accent,
        1.85,
        "none",
        .62,
      );
      appendCircle(scene.artifacts, c2.x, c2.y, 4.0, accent, .84);
      break;
    }

    case "agent": {
      const g = gesture(t, 2.8);
      const angles = [-2.42, -.72, .72, 2.42];

      angles.forEach((angle, i) => {
        const stagger = clamp(g.action - i * .09, 0, 1);
        const radius = 68 + stagger * 29;
        const x = 100 + Math.cos(angle) * radius;
        const y = 100 + Math.sin(angle) * radius * .76;

        appendLine(scene.artifacts, 100, 100, x, y, accent, 1, .10 + stagger * .12);

        const r = 3.6 + stagger * 4.8;
        appendCircle(scene.artifacts, x, y, r, bodyColor, .60 + stagger * .33);
        appendCircle(scene.artifacts, x - 1.6, y - .4, .68, "#fff", .85);
        appendCircle(scene.artifacts, x + 1.6, y - .4, .68, "#fff", .85);
      });
      break;
    }

    case "flow": {
      const g = gesture(t, 2.35);
      const direction = g.cycle % 2 === 0 ? 1 : -1;
      const nodes = [
        { x: 17, y: 131 },
        { x: 56, y: 108 },
        { x: 144, y: 137 },
        { x: 184, y: 105 },
      ];

      appendPath(
        scene.artifacts,
        `M${nodes.map((n) => `${n.x} ${n.y}`).join(" L")}`,
        accent,
        1.45,
        "none",
        .20,
      );

      nodes.forEach((n, index) => {
        const c = appendCircle(
          scene.artifacts,
          n.x,
          n.y,
          index === 0 || index === 3 ? 4.8 : 4.0,
          `${accent}0d`,
          .7,
        );
        c.setAttribute("stroke", accent);
        c.setAttribute("stroke-width", "1.3");
      });

      const from = direction > 0 ? nodes[0]! : nodes[3]!;
      const to = direction > 0 ? nodes[3]! : nodes[0]!;
      const q = clamp(g.action, 0, 1);
      const x = lerp(from.x, to.x, q);
      const y = lerp(from.y, to.y, q);
      appendCircle(scene.artifacts, x, y, 6.0, accent, .09);
      appendCircle(scene.artifacts, x, y, 3.2, accent, .88);
      break;
    }

    case "tuning": {
      const g = gesture(t, 2.2);
      const active = g.cycle % 3;
      const rows = [146, 163, 180];
      const positions = [70, 124, 92];

      rows.forEach((y, index) => {
        appendLine(scene.artifacts, 35, y, 165, y, accent, 1.1, .22);
        const offset = index === active ? (g.reach - .2) * 27 : 0;
        appendCircle(
          scene.artifacts,
          positions[index]! + offset,
          y,
          4.2,
          accent,
          index === active ? .85 : .42,
        );
      });
      break;
    }

    case "security": {
      const g = gesture(t, 2.7);
      const y = lerp(78, 151, clamp(g.action, 0, 1));
      const half = 33 + Math.sin(clamp(g.action, 0, 1) * Math.PI) * 21;

      appendLine(scene.artifacts, 100 - half, y, 100 + half, y, accent, 1.8, .82);
      appendCircle(scene.artifacts, 100 + half, y, 3.1, accent, .9);
      break;
    }
  }
};

const topHighlight = (points: readonly Point[]): string => {
  const selected: Point[] = [];

  for (const p of points) {
    if (p.y < 74 && p.x > 49 && p.x < 143) selected.push(p);
  }

  if (selected.length < 2) return "";

  selected.sort((a, b) => a.x - b.x);

  return (
    `M${selected[0]!.x.toFixed(2)} ${selected[0]!.y.toFixed(2)} ` +
    selected
      .slice(1)
      .map((p) => `L${p.x.toFixed(2)} ${p.y.toFixed(2)}`)
      .join(" ")
  );
};

type Tickable = { tick(now: number): void };

const ACTIVE = new Set<Tickable>();
let sharedRaf = 0;

const sharedLoop = (now: number): void => {
  for (const item of [...ACTIVE]) item.tick(now);

  if (ACTIVE.size) sharedRaf = requestAnimationFrame(sharedLoop);
  else sharedRaf = 0;
};

const register = (item: Tickable): void => {
  ACTIVE.add(item);
  if (!sharedRaf) sharedRaf = requestAnimationFrame(sharedLoop);
};

const unregister = (item: Tickable): void => {
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

  private eyesRoot: SVGGElement | null = null;
  private currentPoints: Point[] = [];
  private currentGaze: Gaze = {
    x: 0,
    y: 0,
    rotate: 0,
    scaleX: 1,
    scaleY: 1,
  };

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

    this.hideSourceBody();
    this.syncIdentity();
    this.playEmotion();

    const initial = professionalShapeAndGaze(
      this.specialist,
      this.state,
      this.reduceMotion ? .8 : 0,
    );
    this.currentPoints = pointsFromShape(initial.shape, this.deformation);
    this.currentGaze = { ...initial.gaze };
    this.renderBody();
    this.applyGaze();

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
    this.scene.root.style.setProperty("--gpv6-accent", color);
  }

  setDeformation(strength: number): void {
    this.deformation = clamp(strength, 0, 1.7);
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

    const dt = clamp((now - this.lastNow) / 1000, 0, .08);
    this.lastNow = now;

    const t = this.reduceMotion ? .82 : (now - this.started) / 1000;
    const target = professionalShapeAndGaze(this.specialist, this.state, t);
    const targetPoints = pointsFromShape(target.shape, this.deformation);

    const bodyResponse = this.reduceMotion ? 1 : 1 - Math.exp(-dt * 13.5);
    const eyeResponse = this.reduceMotion ? 1 : 1 - Math.exp(-dt * 17);

    if (this.currentPoints.length !== targetPoints.length) {
      this.currentPoints = targetPoints.map((p) => ({ ...p }));
    } else {
      for (let i = 0; i < targetPoints.length; i++) {
        const current = this.currentPoints[i]!;
        const next = targetPoints[i]!;
        current.x = lerp(current.x, next.x, bodyResponse);
        current.y = lerp(current.y, next.y, bodyResponse);
      }
    }

    this.currentGaze = {
      x: lerp(this.currentGaze.x, target.gaze.x, eyeResponse),
      y: lerp(this.currentGaze.y, target.gaze.y, eyeResponse),
      rotate: lerp(this.currentGaze.rotate, target.gaze.rotate, eyeResponse),
      scaleX: lerp(this.currentGaze.scaleX, target.gaze.scaleX, eyeResponse),
      scaleY: lerp(this.currentGaze.scaleY, target.gaze.scaleY, eyeResponse),
    };

    this.renderBody();
    this.applyGaze();

    drawWorkingArtifacts(
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
    this.scene.root.style.setProperty("--gpv6-accent", this.accent);
    this.scene.root.style.setProperty("--gpv6-body", this.bodyColor);
    this.scene.root.setAttribute(
      "aria-label",
      `${SPECIALIST_LABEL[this.specialist]} — ${STATE_LABEL[this.state]}`,
    );
  }

  private hideSourceBody(): void {
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
    this.scene.bodyPath.setAttribute("d", closedSpline(this.currentPoints));
    this.scene.highlightPath.setAttribute("d", topHighlight(this.currentPoints));

    let minX = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const p of this.currentPoints) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }

    const width = maxX - minX;
    this.scene.shadow.setAttribute("cy", String(Math.min(190, maxY + 9)));
    this.scene.shadow.setAttribute("rx", String(clamp(width * .35, 25, 70)));
    this.scene.shadow.setAttribute(
      "ry",
      String(this.state === "waiting" ? 5.8 : 7.1),
    );
  }

  private applyGaze(): void {
    if (!this.eyesRoot) return;

    const x = this.currentGaze.x / EYE_COORD_SCALE;
    const y = this.currentGaze.y / EYE_COORD_SCALE;

    this.eyesRoot.setAttribute(
      "transform",
      `translate(${x.toFixed(2)} ${y.toFixed(2)}) ` +
        `rotate(${this.currentGaze.rotate.toFixed(2)} 0 0) ` +
        `scale(${this.currentGaze.scaleX.toFixed(3)} ${this.currentGaze.scaleY.toFixed(3)})`,
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
  const deformation = clamp(options.deformation ?? 1, 0, 1.7);
  const statusCues = options.statusCues ?? true;

  const numericSize =
    typeof size === "number" ? size : Number.parseFloat(String(size)) || 220;

  const detailed = numericSize >= 150;

  const scene = createScene(size, bodyColor, accent, statusCues);

  const avatarHost = document.createElement("div");
  avatarHost.className = "gpv6-avatar";
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
 * alguma combinação ficar sem animação. Um buraco aqui não quebra nada em
 * execução — `pickAnimation` cai no fallback — e por isso mesmo precisa de
 * guarda: ele só apareceria como um bot parado na tela.
 */
export const PROFESSIONAL_GROK_BEHAVIOR_MAP = ANIMATION_CANDIDATES;
export const GROK_SPECIALIST_BEHAVIOR_MAP = ANIMATION_CANDIDATES;
