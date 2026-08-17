/**
 * grok_specialist_avatar_v2.ts
 *
 * Wrapper for an avatar package exported by Bible Strong Avatar Lab.
 * The avatar itself stays the black procedural sphere with white eyes.
 * Specialist identity comes from expression/animation + subtle SVG activity cues.
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
  accent?: string;
  showActivityGlyphs?: boolean;
  showStateRing?: boolean;
}

export interface GrokSpecialistAvatarController {
  readonly element: HTMLElement;
  getSpecialist(): GrokSpecialist;
  getState(): GrokSpecialistState;
  setSpecialist(specialist: GrokSpecialist): void;
  setState(state: GrokSpecialistState): void;
  setAccent(color: string): void;
  replay(): void;
  pause(): void;
  resume(): void;
  destroy(): void;
}

type SpecialistVisual = {
  accent: string;
  activeAnimations: readonly string[];
  ownerAnimations: readonly string[];
  workingAnimations: readonly string[];
  waitingAnimations: readonly string[];
  completedAnimations: readonly string[];
};

const SPECIALIST_VISUALS: Record<GrokSpecialist, SpecialistVisual> = {
  chat: {
    accent: "#55c7ff",
    activeAnimations: ["listening", "idle"],
    ownerAnimations: ["proud", "listening", "idle"],
    workingAnimations: ["listening", "working", "thinking"],
    waitingAnimations: ["sleeping", "drowsy", "idle"],
    completedAnimations: ["happy", "celebrate", "idle"],
  },
  code: {
    accent: "#66e28f",
    activeAnimations: ["idle", "listening"],
    ownerAnimations: ["proud", "thinking", "idle"],
    workingAnimations: ["working", "thinking", "searching"],
    waitingAnimations: ["sleeping", "drowsy", "idle"],
    completedAnimations: ["celebrate", "happy", "idle"],
  },
  data: {
    accent: "#72a7ff",
    activeAnimations: ["curious", "listening", "idle"],
    ownerAnimations: ["proud", "curious", "idle"],
    workingAnimations: ["searching", "thinking", "working"],
    waitingAnimations: ["sleeping", "drowsy", "idle"],
    completedAnimations: ["happy", "celebrate", "idle"],
  },
  design: {
    accent: "#e985ff",
    activeAnimations: ["curious", "idle", "listening"],
    ownerAnimations: ["proud", "curious", "idle"],
    workingAnimations: ["curious", "thinking", "excited", "working"],
    waitingAnimations: ["sleeping", "drowsy", "idle"],
    completedAnimations: ["happy", "celebrate", "idle"],
  },
  agent: {
    accent: "#a995ff",
    activeAnimations: ["listening", "idle"],
    ownerAnimations: ["proud", "thinking", "idle"],
    workingAnimations: ["thinking", "searching", "working"],
    waitingAnimations: ["sleeping", "drowsy", "idle"],
    completedAnimations: ["celebrate", "happy", "idle"],
  },
  flow: {
    accent: "#ff9d62",
    activeAnimations: ["idle", "listening"],
    ownerAnimations: ["proud", "idle"],
    workingAnimations: ["working", "searching", "thinking"],
    waitingAnimations: ["sleeping", "drowsy", "idle"],
    completedAnimations: ["celebrate", "happy", "idle"],
  },
  tuning: {
    accent: "#f4ce64",
    activeAnimations: ["curious", "idle"],
    ownerAnimations: ["proud", "thinking", "idle"],
    workingAnimations: ["thinking", "searching", "working"],
    waitingAnimations: ["sleeping", "drowsy", "idle"],
    completedAnimations: ["happy", "celebrate", "idle"],
  },
  security: {
    accent: "#5de0c5",
    activeAnimations: ["suspicious", "listening", "idle"],
    ownerAnimations: ["proud", "suspicious", "idle"],
    workingAnimations: ["searching", "suspicious", "working"],
    waitingAnimations: ["sleeping", "drowsy", "idle"],
    completedAnimations: ["happy", "celebrate", "idle"],
  },
};

const SPECIALIST_LABELS: Record<GrokSpecialist, string> = {
  chat: "Chat",
  code: "Code",
  data: "Data",
  design: "Design",
  agent: "Agent",
  flow: "Fluxo",
  tuning: "Tuning",
  security: "Security",
};

const STATE_LABELS: Record<GrokSpecialistState, string> = {
  active: "Ativo",
  owner: "Owner",
  working: "Trabalhando",
  waiting: "Em espera",
  completed: "Concluído",
};

const FALLBACK_ANIMATIONS = [
  "idle",
  "listening",
  "thinking",
  "working",
  "sleeping",
] as const;

const stateCandidates = (
  specialist: GrokSpecialist,
  state: GrokSpecialistState,
): readonly string[] => {
  const visual = SPECIALIST_VISUALS[specialist];

  switch (state) {
    case "active":
      return visual.activeAnimations;
    case "owner":
      return visual.ownerAnimations;
    case "working":
      return visual.workingAnimations;
    case "waiting":
      return visual.waitingAnimations;
    case "completed":
      return visual.completedAnimations;
  }
};

const pickAnimation = (
  available: readonly string[],
  specialist: GrokSpecialist,
  state: GrokSpecialistState,
): string | undefined => {
  const pool = new Set(available);

  for (const animation of stateCandidates(specialist, state)) {
    if (pool.has(animation)) return animation;
  }

  for (const animation of FALLBACK_ANIMATIONS) {
    if (pool.has(animation)) return animation;
  }

  return available[0];
};

const resolveTarget = (target: Element | string): HTMLElement => {
  const node =
    typeof target === "string" ? document.querySelector(target) : target;

  if (!node) {
    throw new Error(`Avatar target not found: ${String(target)}`);
  }

  if (!(node instanceof HTMLElement)) {
    throw new Error("Avatar target must be an HTMLElement.");
  }

  return node;
};

const loadAvatarModule = async (moduleUrl: string): Promise<AvatarLabModule> => {
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

const SVG_NS = "http://www.w3.org/2000/svg";

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

const appendLine = (
  parent: SVGElement,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  width = 2,
  opacity = 0.85,
): void => {
  parent.appendChild(
    makeSvg("line", {
      x1,
      y1,
      x2,
      y2,
      stroke: "currentColor",
      "stroke-width": width,
      "stroke-linecap": "round",
      opacity,
    }),
  );
};

const appendCircle = (
  parent: SVGElement,
  cx: number,
  cy: number,
  r: number,
  opacity = 0.85,
): void => {
  parent.appendChild(
    makeSvg("circle", {
      cx,
      cy,
      r,
      fill: "currentColor",
      opacity,
    }),
  );
};

const appendPath = (
  parent: SVGElement,
  d: string,
  width = 2,
  opacity = 0.85,
): void => {
  parent.appendChild(
    makeSvg("path", {
      d,
      fill: "none",
      stroke: "currentColor",
      "stroke-width": width,
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      opacity,
    }),
  );
};

const clear = (element: Element): void => {
  while (element.firstChild) element.removeChild(element.firstChild);
};

const ensureStyles = (): void => {
  if (document.getElementById("gsa-style")) return;

  const style = document.createElement("style");
  style.id = "gsa-style";
  style.textContent = `
.gsa-root {
  --gsa-size: 220px;
  --gsa-accent: #55c7ff;
  width: var(--gsa-size);
  height: var(--gsa-size);
  position: relative;
  display: grid;
  place-items: center;
  isolation: isolate;
  overflow: visible;
}

.gsa-avatar {
  position: absolute;
  inset: 8%;
  z-index: 2;
  display: grid;
  place-items: center;
}

.gsa-avatar > * {
  width: 100% !important;
  height: 100% !important;
}

.gsa-overlay {
  position: absolute;
  inset: 0;
  z-index: 3;
  width: 100%;
  height: 100%;
  overflow: visible;
  pointer-events: none;
  color: var(--gsa-accent);
}

.gsa-ring {
  fill: none;
  stroke: currentColor;
  stroke-width: 1.5;
  transform-origin: 100px 100px;
  opacity: 0;
}

.gsa-root[data-state="active"] .gsa-ring {
  opacity: .18;
  animation: gsa-breathe 3s ease-in-out infinite;
}

.gsa-root[data-state="owner"] .gsa-ring {
  opacity: .74;
  stroke-width: 2;
  stroke-dasharray: 11 8;
  animation: gsa-owner-spin 9s linear infinite;
}

.gsa-root[data-state="working"] .gsa-ring {
  opacity: .38;
  stroke-dasharray: 3 8;
  animation: gsa-work-spin 3s linear infinite;
}

.gsa-root[data-state="waiting"] .gsa-ring {
  opacity: .07;
}

.gsa-root[data-state="completed"] .gsa-ring {
  opacity: .28;
  animation: gsa-complete-pulse 2.6s ease-in-out infinite;
}

.gsa-glyph {
  opacity: .72;
  transition: opacity .2s ease;
}

.gsa-root[data-state="working"] .gsa-glyph {
  opacity: .95;
}

.gsa-root[data-state="waiting"] .gsa-glyph {
  opacity: .14;
}

.gsa-root[data-state="completed"] .gsa-glyph {
  opacity: .42;
}

.gsa-particle {
  fill: currentColor;
  opacity: 0;
}

.gsa-root[data-state="working"] .gsa-particle {
  animation: gsa-particle 1.4s ease-in-out infinite;
}

.gsa-root[data-state="owner"] .gsa-particle {
  animation: gsa-particle 2.8s ease-in-out infinite;
}

.gsa-owner-dot {
  fill: currentColor;
  opacity: 0;
}

.gsa-root[data-state="owner"] .gsa-owner-dot {
  opacity: .88;
  animation: gsa-owner-dot 2s ease-in-out infinite;
}

.gsa-z {
  fill: currentColor;
  font: 700 12px ui-sans-serif, system-ui, sans-serif;
  opacity: 0;
}

.gsa-root[data-state="waiting"] .gsa-z {
  animation: gsa-z 2.4s ease-in-out infinite;
}

.gsa-check {
  fill: none;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
  opacity: 0;
  transform-origin: 170px 167px;
}

.gsa-root[data-state="completed"] .gsa-check {
  opacity: .95;
  animation: gsa-check 2.5s ease-in-out infinite;
}

@keyframes gsa-breathe {
  0%,100% { transform: scale(.985); opacity: .12; }
  50% { transform: scale(1.018); opacity: .28; }
}

@keyframes gsa-owner-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

@keyframes gsa-work-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(-360deg); }
}

@keyframes gsa-complete-pulse {
  0%,100% { transform: scale(.99); opacity: .19; }
  50% { transform: scale(1.025); opacity: .36; }
}

@keyframes gsa-particle {
  0% { opacity: 0; transform: translate(0,0) scale(.7); }
  30% { opacity: .9; }
  100% { opacity: 0; transform: translate(8px,-10px) scale(1.08); }
}

@keyframes gsa-owner-dot {
  0%,100% { opacity: .4; transform: scale(.7); }
  50% { opacity: 1; transform: scale(1.15); }
}

@keyframes gsa-z {
  0% { opacity: 0; transform: translate(0,4px) scale(.8); }
  25% { opacity: .75; }
  100% { opacity: 0; transform: translate(12px,-18px) scale(1.1); }
}

@keyframes gsa-check {
  0%,70%,100% { transform: scale(.95); opacity: .72; }
  82% { transform: scale(1.1); opacity: 1; }
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

const drawSpecialistGlyph = (
  group: SVGGElement,
  specialist: GrokSpecialist,
): void => {
  clear(group);

  switch (specialist) {
    case "chat": {
      group.appendChild(
        makeSvg("path", {
          d: "M24 54 Q24 43 35 43 H61 Q72 43 72 54 V66 Q72 77 61 77 H46 L38 85 V77 H35 Q24 77 24 66 Z",
          fill: "none",
          stroke: "currentColor",
          "stroke-width": 2.2,
          opacity: 0.82,
        }),
      );
      appendCircle(group, 38, 60, 2);
      appendCircle(group, 48, 60, 2);
      appendCircle(group, 58, 60, 2);
      break;
    }

    case "code":
      appendPath(group, "M37 50 L24 64 L37 78", 2.5, 0.9);
      appendPath(group, "M61 50 L74 64 L61 78", 2.5, 0.9);
      appendLine(group, 55, 47, 45, 81, 2.4, 0.82);
      break;

    case "data":
      appendLine(group, 27, 82, 27, 68, 7, 0.48);
      appendLine(group, 42, 82, 42, 54, 7, 0.66);
      appendLine(group, 57, 82, 57, 39, 7, 0.9);
      appendCircle(group, 29, 45, 3.2, 0.58);
      appendCircle(group, 43, 35, 3.2, 0.72);
      appendCircle(group, 58, 27, 3.2, 0.9);
      appendPath(group, "M29 45 L43 35 L58 27", 1.6, 0.42);
      break;

    case "design":
      appendPath(group, "M24 76 C34 38 63 41 76 66", 2.2, 0.85);
      appendLine(group, 24, 76, 36, 42, 1.2, 0.34);
      appendLine(group, 76, 66, 64, 42, 1.2, 0.34);
      appendCircle(group, 24, 76, 3, 0.92);
      appendCircle(group, 36, 42, 2.4, 0.58);
      appendCircle(group, 64, 42, 2.4, 0.58);
      appendCircle(group, 76, 66, 3, 0.92);
      break;

    case "agent": {
      appendCircle(group, 50, 58, 5.4, 0.92);
      const nodes = [
        [27, 39],
        [73, 39],
        [27, 78],
        [73, 78],
      ] as const;

      for (const [x, y] of nodes) {
        appendLine(group, 50, 58, x, y, 1.3, 0.34);
        appendCircle(group, x, y, 3.5, 0.68);
      }
      break;
    }

    case "flow":
      appendCircle(group, 27, 58, 5.2, 0.76);
      group.appendChild(
        makeSvg("path", {
          d: "M50 49 L59 58 L50 67 L41 58 Z",
          fill: "none",
          stroke: "currentColor",
          "stroke-width": 2,
          opacity: 0.82,
        }),
      );
      group.appendChild(
        makeSvg("rect", {
          x: 70,
          y: 50.5,
          width: 15,
          height: 15,
          rx: 4,
          fill: "none",
          stroke: "currentColor",
          "stroke-width": 2,
          opacity: 0.9,
        }),
      );
      appendLine(group, 32, 58, 41, 58, 1.7, 0.42);
      appendLine(group, 59, 58, 70, 58, 1.7, 0.42);
      break;

    case "tuning": {
      const rows = [41, 58, 75];
      const knobX = [42, 65, 34];
      rows.forEach((y, i) => {
        appendLine(group, 24, y, 78, y, 1.4, 0.4);
        // [ADAPTAÇÃO] fallback exigido pelo noUncheckedIndexedAccess do repo.
        appendCircle(group, knobX[i] ?? 42, y, 4.1, 0.9);
      });
      break;
    }

    case "security":
      appendPath(
        group,
        "M50 27 L72 36 V54 Q71 72 50 84 Q29 72 28 54 V36 Z",
        2.2,
        0.86,
      );
      appendLine(group, 35, 56, 65, 56, 1.8, 0.7);
      break;
  }
};

const createOverlay = (
  specialist: GrokSpecialist,
  showGlyphs: boolean,
  showRing: boolean,
): { overlay: SVGSVGElement; glyph: SVGGElement } => {
  const overlay = makeSvg("svg", {
    class: "gsa-overlay",
    viewBox: "0 0 200 200",
    "aria-hidden": "true",
  });

  if (showRing) {
    overlay.appendChild(
      makeSvg("circle", {
        class: "gsa-ring",
        cx: 100,
        cy: 100,
        r: 91,
      }),
    );
  }

  const glyph = makeSvg("g", {
    class: "gsa-glyph",
    transform: "translate(4 4) scale(.62)",
  });

  if (showGlyphs) {
    drawSpecialistGlyph(glyph, specialist);
    overlay.appendChild(glyph);
  }

  const particlePoints = [
    [145, 45, 1.8],
    [166, 67, 1.4],
    [157, 94, 1.2],
    [48, 151, 1.6],
    [30, 129, 1.3],
  ] as const;

  particlePoints.forEach(([cx, cy, r], i) => {
    overlay.appendChild(
      makeSvg("circle", {
        cx,
        cy,
        r,
        class: "gsa-particle",
        style: `animation-delay:${i * 150}ms`,
      }),
    );
  });

  const ownerDots = [
    [79, 16, 2.4],
    [100, 10, 3.2],
    [121, 16, 2.4],
  ] as const;

  ownerDots.forEach(([cx, cy, r], i) => {
    overlay.appendChild(
      makeSvg("circle", {
        cx,
        cy,
        r,
        class: "gsa-owner-dot",
        style: `animation-delay:${i * 220}ms`,
      }),
    );
  });

  const z1 = makeSvg("text", {
    x: 154,
    y: 54,
    class: "gsa-z",
  });
  z1.textContent = "Z";
  overlay.appendChild(z1);

  const z2 = makeSvg("text", {
    x: 168,
    y: 40,
    class: "gsa-z",
    style: "animation-delay:650ms",
  });
  z2.textContent = "z";
  overlay.appendChild(z2);

  overlay.appendChild(
    makeSvg("circle", {
      cx: 170,
      cy: 167,
      r: 17,
      class: "gsa-check",
      "stroke-width": 1.5,
    }),
  );

  overlay.appendChild(
    makeSvg("path", {
      d: "M161 167 L167 173 L179 159",
      class: "gsa-check",
      "stroke-width": 3,
    }),
  );

  return { overlay, glyph };
};

class Controller implements GrokSpecialistAvatarController {
  readonly element: HTMLElement;

  private instance: AvatarLabInstance;
  private available: readonly string[];
  private root: HTMLDivElement;
  private glyph: SVGGElement;
  private specialist: GrokSpecialist;
  private state: GrokSpecialistState;
  private accent: string;
  private completedTimer?: number;

  constructor(params: {
    element: HTMLElement;
    instance: AvatarLabInstance;
    available: readonly string[];
    root: HTMLDivElement;
    glyph: SVGGElement;
    specialist: GrokSpecialist;
    state: GrokSpecialistState;
    accent: string;
  }) {
    this.element = params.element;
    this.instance = params.instance;
    this.available = params.available;
    this.root = params.root;
    this.glyph = params.glyph;
    this.specialist = params.specialist;
    this.state = params.state;
    this.accent = params.accent;

    this.sync();
    this.playCurrent();
  }

  getSpecialist(): GrokSpecialist {
    return this.specialist;
  }

  getState(): GrokSpecialistState {
    return this.state;
  }

  setSpecialist(specialist: GrokSpecialist): void {
    if (this.specialist === specialist) return;

    this.specialist = specialist;
    drawSpecialistGlyph(this.glyph, specialist);
    this.setAccent(SPECIALIST_VISUALS[specialist].accent);
    this.sync();
    this.playCurrent();
  }

  setState(state: GrokSpecialistState): void {
    if (this.state === state) return;

    this.state = state;
    this.sync();
    this.playCurrent();
  }

  setAccent(color: string): void {
    this.accent = color;
    this.root.style.setProperty("--gsa-accent", color);
  }

  replay(): void {
    this.playCurrent();
  }

  pause(): void {
    this.instance.pause();
  }

  resume(): void {
    this.playCurrent();
  }

  destroy(): void {
    if (this.completedTimer !== undefined) {
      window.clearTimeout(this.completedTimer);
    }

    this.instance.destroy?.();
    this.root.remove();
  }

  private sync(): void {
    this.root.dataset.specialist = this.specialist;
    this.root.dataset.state = this.state;
    this.root.style.setProperty("--gsa-accent", this.accent);
    this.root.setAttribute(
      "aria-label",
      `${SPECIALIST_LABELS[this.specialist]} — ${STATE_LABELS[this.state]}`,
    );
  }

  private playCurrent(): void {
    if (this.completedTimer !== undefined) {
      window.clearTimeout(this.completedTimer);
      this.completedTimer = undefined;
    }

    const animation = pickAnimation(
      this.available,
      this.specialist,
      this.state,
    );

    if (!animation) {
      this.instance.stop();
      return;
    }

    this.instance.play(animation);

    if (this.state === "completed" && animation === "celebrate") {
      this.completedTimer = window.setTimeout(() => {
        if (this.state !== "completed") return;

        const settle = this.available.includes("happy")
          ? "happy"
          : this.available.includes("idle")
            ? "idle"
            : undefined;

        if (settle) this.instance.play(settle);
      }, 2800);
    }
  }
}

export async function mountGrokSpecialistAvatar(
  target: Element | string,
  options: MountGrokSpecialistOptions,
): Promise<GrokSpecialistAvatarController> {
  if (typeof window === "undefined" || typeof document === "undefined") {
    throw new Error(
      "mountGrokSpecialistAvatar() must run in the browser/client runtime.",
    );
  }

  ensureStyles();

  const element = resolveTarget(target);
  const module = await loadAvatarModule(options.moduleUrl);

  const state = options.state ?? "active";
  const visual = SPECIALIST_VISUALS[options.specialist];
  const accent = options.accent ?? visual.accent;
  const showGlyphs = options.showActivityGlyphs ?? true;
  const showRing = options.showStateRing ?? true;
  const size = options.size ?? 220;

  const root = document.createElement("div");
  root.className = "gsa-root";
  root.style.setProperty(
    "--gsa-size",
    typeof size === "number" ? `${size}px` : size,
  );
  root.style.setProperty("--gsa-accent", accent);

  const avatarHost = document.createElement("div");
  avatarHost.className = "gsa-avatar";

  const { overlay, glyph } = createOverlay(
    options.specialist,
    showGlyphs,
    showRing,
  );

  root.appendChild(avatarHost);
  root.appendChild(overlay);
  element.appendChild(root);

  const initialAnimation = pickAnimation(
    module.availableAnimations,
    options.specialist,
    state,
  );

  const instance = module.createAvatar(avatarHost, {
    animation: initialAnimation,
    size: "100%",
    autoplay: false,
  });

  return new Controller({
    element,
    instance,
    available: module.availableAnimations,
    root,
    glyph,
    specialist: options.specialist,
    state,
    accent,
  });
}

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

export const GROK_SPECIALIST_BEHAVIOR_MAP = Object.freeze({
  chat: Object.freeze({
    active: "listening",
    owner: "proud",
    working: "listening",
    waiting: "sleeping",
    completed: "happy",
  }),
  code: Object.freeze({
    active: "idle",
    owner: "proud",
    working: "working",
    waiting: "sleeping",
    completed: "celebrate",
  }),
  data: Object.freeze({
    active: "curious",
    owner: "proud",
    working: "searching",
    waiting: "sleeping",
    completed: "happy",
  }),
  design: Object.freeze({
    active: "curious",
    owner: "proud",
    working: "curious",
    waiting: "sleeping",
    completed: "happy",
  }),
  agent: Object.freeze({
    active: "listening",
    owner: "proud",
    working: "thinking",
    waiting: "sleeping",
    completed: "celebrate",
  }),
  flow: Object.freeze({
    active: "idle",
    owner: "proud",
    working: "working",
    waiting: "sleeping",
    completed: "celebrate",
  }),
  tuning: Object.freeze({
    active: "curious",
    owner: "proud",
    working: "thinking",
    waiting: "sleeping",
    completed: "happy",
  }),
  security: Object.freeze({
    active: "suspicious",
    owner: "proud",
    working: "searching",
    waiting: "sleeping",
    completed: "happy",
  }),
} satisfies Record<
  GrokSpecialist,
  Record<GrokSpecialistState, string>
>);
