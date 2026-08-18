/**
 * GrokSlimeCore.ts
 *
 * V9 — motion-first Grok-like slime.
 *
 * IMPORTANT:
 * - a animação profissional do Claude permanece fora deste arquivo;
 * - este motor cuida SOMENTE do corpo/olhos do slime;
 * - o corpo precisa se mover mesmo quando a tarefa profissional é visualmente
 *   simples;
 * - os ciclos/timings abaixo seguem a linguagem do Avatar Lab:
 *   hold longo + transition smooth, em vez de seno quase parado.
 *
 * O corpo combina:
 *  1. pose semântica (headX/headY/headZ);
 *  2. transição de 500ms entre poses;
 *  3. slow drift irregular;
 *  4. slosh/inércia com spring subamortecido;
 *  5. pressão local da especialidade;
 *  6. conservação aproximada de volume.
 */

export type SlimeSpecialist =
  | "chat"
  | "code"
  | "data"
  | "design"
  | "agent"
  | "flow"
  | "tuning"
  | "security";

export type SlimeState =
  | "active"
  | "owner"
  | "working"
  | "waiting"
  | "completed";

export interface GrokSlimeUpdate {
  specialist: SlimeSpecialist;
  state: SlimeState;
  time: number;
  dt: number;
  strength?: number;
}

export interface GrokSlimeOptions {
  svg: SVGSVGElement;
  before?: Element | null;
  avatarHost: HTMLElement;
  bodyColor?: string;
}

type Point = { x: number; y: number };

type Pressure = {
  angle: number;
  amount: number;
  width: number;
};

type HeadPose = {
  x: number;
  y: number;
  z: number;
};

type Sequence = {
  poses: readonly HeadPose[];
  holdMs: number;
  transitionMs: number;
};

type SequenceSample = {
  pose: HeadPose;
  phase: "hold" | "transition";
  transitionProgress: number;
  step: number;
};

type Intent = {
  cx: number;
  cy: number;
  sx: number;
  sy: number;
  rotate: number;
  pressures: Pressure[];
  gazeX: number;
  gazeY: number;
  gazeRotate: number;
  gazeScaleX: number;
  gazeScaleY: number;
  gradientX: number;
  gradientY: number;
  transitionEnergy: number;
};

type Spring = {
  value: number;
  velocity: number;
};

const SVG_NS = "http://www.w3.org/2000/svg";
const TAU = Math.PI * 2;
const POINT_COUNT = 48;
const STAGE_TO_EYE = 1 / 0.709;

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

const lerp = (a: number, b: number, t: number): number =>
  a + (b - a) * t;

const smooth = (value: number): number => {
  const t = clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
};

const smoother = (value: number): number => {
  const t = clamp(value, 0, 1);
  return t * t * t * (t * (t * 6 - 15) + 10);
};

const wave = (time: number, speed = 1, phase = 0): number =>
  Math.sin(time * speed + phase);

const sin01 = (time: number, speed = 1, phase = 0): number =>
  0.5 + 0.5 * wave(time, speed, phase);

const pingPong = (time: number): number => {
  const p = ((time % 2) + 2) % 2;
  return p <= 1 ? p : 2 - p;
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

const angleDistance = (a: number, b: number): number => {
  let d = Math.abs(a - b) % TAU;
  if (d > Math.PI) d = TAU - d;
  return d;
};

const gaussian = (angle: number, center: number, width: number): number => {
  const d = angleDistance(angle, center);
  return Math.exp(-(d * d) / (2 * width * width));
};

const hash = (value: number): number => {
  const raw = Math.sin(value * 127.1 + 311.7) * 43758.5453;
  return (raw - Math.floor(raw)) * 2 - 1;
};

const smoothNoise = (
  elapsedMs: number,
  axis: number,
  seed: number,
  interval: number,
): number => {
  const progress = elapsedMs / interval;
  const step = Math.floor(progress);
  const blend = smooth(progress - step);
  const previous = hash(step * 3 + axis + seed);
  const next = hash((step + 1) * 3 + axis + seed);
  return lerp(previous, next, blend);
};

const spring = (value: number): Spring => ({ value, velocity: 0 });

/**
 * Deliberadamente subamortecido.
 * A V8 usava damping alto demais e "matava" o movimento antes dele ficar visível.
 */
const stepSpring = (
  s: Spring,
  target: number,
  dt: number,
  stiffness = 125,
  damping = 10.5,
): void => {
  const safeDt = clamp(dt, 0, 0.045);
  const acceleration = (target - s.value) * stiffness;
  s.velocity += acceleration * safeDt;
  s.velocity *= Math.exp(-damping * safeDt);
  s.value += s.velocity * safeDt;
};

const closedSpline = (points: readonly Point[]): string => {
  if (points.length < 3) return "";

  const n = points.length;
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

/**
 * Quantos pontos de cada lado do topo entram no brilho.
 *
 * 8 de 48 é ~60° por lado — a mesma faixa que a seleção por caixa pegava na
 * média (13 a 18 pontos), só que agora ela não varia.
 */
const HIGHLIGHT_SPAN = 8;

/**
 * O brilho é uma faixa ANGULAR do corpo, não um recorte do palco.
 *
 * Antes os pontos eram filtrados por uma caixa absoluta do viewBox
 * (y < 76, 42 < x < 148) enquanto o corpo passeia ±11 unidades com o centro em
 * mola: a cada quadro entrava ou saía uma amostra inteira da seleção. Medido em
 * jsdom, `data`/`working` oscilava entre 13 e 18 pontos e trocava 83 vezes em
 * 30 s — a ponta do reflexo saltava 7,7 unidades (~5px na ficha de 124px) umas
 * três vezes por segundo, em vez de deslizar. Escolhendo por índice, a contagem
 * é constante por construção e o brilho acompanha o corpo, inclusive quando ele
 * inclina ou desce.
 */
const highlightSpline = (points: readonly Point[]): string => {
  if (points.length < 2) return "";

  return (
    `M${points[0]!.x.toFixed(2)} ${points[0]!.y.toFixed(2)} ` +
    points
      .slice(1)
      .map((point) => `L${point.x.toFixed(2)} ${point.y.toFixed(2)}`)
      .join(" ")
  );
};

const pointAlong = (
  points: readonly Point[],
  progress: number,
): Point => {
  if (points.length < 2) return points[0] ?? { x: 100, y: 100 };

  const scaled = clamp(progress, 0, 1) * (points.length - 1);
  const index = Math.min(points.length - 2, Math.floor(scaled));
  const local = scaled - index;
  const a = points[index]!;
  const b = points[index + 1]!;

  return {
    x: lerp(a.x, b.x, local),
    y: lerp(a.y, b.y, local),
  };
};

/**
 * Valores de headX/headY/headZ usados pelo documento padrão do Avatar Lab.
 *
 * O ponto importante aqui não é "copiar uma bolinha":
 * é usar a mesma amplitude de orientação. A V8 quase não movia o centro,
 * então o corpo parecia congelado.
 */
const POSE = {
  p00: { x: 7.3, y: 27.8, z: -16.1 },
  p01: { x: -15.0578, y: 0.1430, z: -14.5492 },
  p02: { x: -15.2871, y: 15.0066, z: 12.7879 },
  p03: { x: 2.9469, y: -16.0512, z: -20.9160 },
  p04: { x: 3.4, y: 13.2258, z: 8.9770 },
  p05: { x: -16.5285, y: -3.7680, z: -13.7297 },
  p07: { x: 8.0637, y: 17.6266, z: -11.1168 },
  p08: { x: -12.3035, y: -17.6012, z: 5.9109 },
  p09: { x: -20.0582, y: 12.6074, z: -12.7 },
  p10: { x: 1.4336, y: 6.1941, z: 10.5602 },
  p11: { x: -2.0930, y: -15.8996, z: -14.4699 },
  p12: { x: -19.2086, y: 15.2, z: 11.8 },
  p13: { x: -8.7523, y: -8.7434, z: -10.7738 },
  p14: { x: 3.5293, y: -7.0766, z: 9.8301 },
  p15: { x: 0.3191, y: 35.3074, z: -10.9043 },
  p16: { x: -14.7508, y: -19.35, z: 5.6316 },
  p17: { x: -4.3953, y: 14.0727, z: -16.1262 },
  p18: { x: 6.5855, y: 4.7371, z: 12.8402 },
  p19: { x: -6.0777, y: -11.0352, z: -13.9656 },
  p20: { x: -17.1277, y: 18.0707, z: 13.8918 },
  p21: { x: -5.4281, y: -11.7133, z: -13.4723 },
  p22: { x: 10.2926, y: 3.3992, z: 7.5832 },
  p23: { x: -17.8, y: 10.0, z: -10.8949 },
} as const;

const SEQUENCE = {
  idle: {
    poses: [POSE.p00, POSE.p08],
    holdMs: 5200,
    transitionMs: 500,
  },
  listening: {
    poses: [POSE.p10, POSE.p01, POSE.p19],
    holdMs: 2300,
    transitionMs: 500,
  },
  thinking: {
    poses: [POSE.p08, POSE.p16, POSE.p14, POSE.p17, POSE.p05],
    holdMs: 2300,
    transitionMs: 500,
  },
  searching: {
    poses: [POSE.p15, POSE.p09, POSE.p03, POSE.p20, POSE.p12, POSE.p18],
    holdMs: 2300,
    transitionMs: 500,
  },
  working: {
    poses: [POSE.p07, POSE.p16, POSE.p11, POSE.p10],
    holdMs: 2300,
    transitionMs: 500,
  },
  sleeping: {
    poses: [POSE.p13, POSE.p22, POSE.p04],
    holdMs: 3600,
    transitionMs: 500,
  },
  suspicious: {
    poses: [POSE.p14, POSE.p05, POSE.p23],
    holdMs: 2300,
    transitionMs: 500,
  },
  happy: {
    poses: [POSE.p02, POSE.p11, POSE.p17, POSE.p19],
    holdMs: 2300,
    transitionMs: 500,
  },
} satisfies Record<string, Sequence>;

const sequenceFor = (
  specialist: SlimeSpecialist,
  state: SlimeState,
): Sequence => {
  if (state === "waiting") return SEQUENCE.sleeping;
  if (state === "completed") return SEQUENCE.happy;
  if (state === "owner") return SEQUENCE.listening;
  if (state === "active") return SEQUENCE.idle;

  switch (specialist) {
    case "chat":
      return SEQUENCE.listening;
    case "code":
      return SEQUENCE.working;
    case "data":
      return SEQUENCE.searching;
    case "design":
      return SEQUENCE.thinking;
    case "agent":
      return SEQUENCE.thinking;
    case "flow":
      return SEQUENCE.working;
    case "tuning":
      return SEQUENCE.thinking;
    case "security":
      return SEQUENCE.suspicious;
  }
};

const sampleSequence = (
  sequence: Sequence,
  timeSeconds: number,
  phaseOffsetSeconds: number,
): SequenceSample => {
  const hold = sequence.holdMs / 1000;
  const transition = sequence.transitionMs / 1000;
  const segment = hold + transition;
  const cycle = segment * sequence.poses.length;

  const local = ((timeSeconds + phaseOffsetSeconds) % cycle + cycle) % cycle;
  const step = Math.floor(local / segment) % sequence.poses.length;
  const within = local - step * segment;

  const from = sequence.poses[step]!;
  const to = sequence.poses[(step + 1) % sequence.poses.length]!;

  if (within <= hold) {
    return {
      pose: from,
      phase: "hold",
      transitionProgress: 0,
      step,
    };
  }

  const raw = clamp((within - hold) / transition, 0, 1);
  const eased = smoother(raw);

  return {
    pose: {
      x: lerp(from.x, to.x, eased),
      y: lerp(from.y, to.y, eased),
      z: lerp(from.z, to.z, eased),
    },
    phase: "transition",
    transitionProgress: raw,
    step,
  };
};

const specialistPhase = (specialist: SlimeSpecialist): number => {
  switch (specialist) {
    case "chat": return 0.00;
    case "code": return 0.38;
    case "data": return 0.76;
    case "design": return 1.14;
    case "agent": return 1.52;
    case "flow": return 1.90;
    case "tuning": return 2.28;
    case "security": return 2.66;
  }
};

const reactivePressures = (
  specialist: SlimeSpecialist,
  state: SlimeState,
  time: number,
): Pressure[] => {
  if (state !== "working") return [];

  switch (specialist) {
    case "chat": {
      const side = sin01(time, 2.4) > 0.5 ? -1 : 1;
      return [
        {
          angle: side < 0 ? Math.PI : 0,
          amount: 5.2 + sin01(time, 6) * 2.5,
          width: 0.50,
        },
      ];
    }

    case "code": {
      return [
        {
          angle: 2.02,
          amount: 3.8 + Math.max(0, wave(time, 10)) * 3.2,
          width: 0.31,
        },
        {
          angle: 1.12,
          amount: 3.8 + Math.max(0, wave(time, 10, Math.PI)) * 3.2,
          width: 0.31,
        },
      ];
    }

    case "data": {
      const graph = [
        { x: 28, y: 119 },
        { x: 48, y: 105 },
        { x: 70, y: 114 },
        { x: 94, y: 87 },
        { x: 121, y: 99 },
        { x: 150, y: 70 },
        { x: 172, y: 80 },
      ];
      const target = pointAlong(graph, pingPong(time * 0.7));
      return [
        {
          angle: Math.atan2(target.y - 100, target.x - 100),
          amount: 6.8,
          width: 0.41,
        },
      ];
    }

    case "design": {
      const target = {
        x: 132 + wave(time, 1.6, 1) * 9,
        y: 168 + wave(time, 1.2, 2) * 8,
      };
      return [
        {
          angle: Math.atan2(target.y - 100, target.x - 100),
          amount: 7.3,
          width: 0.39,
        },
      ];
    }

    case "agent": {
      return Array.from({ length: 4 }, (_, index) => {
        const phase = index / 4;
        return {
          angle: time * 0.55 + phase * TAU,
          amount: 2.0 + sin01(time, 1.4, phase * TAU) * 2.4,
          width: 0.34,
        };
      });
    }

    case "flow": {
      const nodes = [
        { x: 24, y: 132 },
        { x: 66, y: 108 },
        { x: 111, y: 138 },
        { x: 162, y: 104 },
      ];
      const packet = pointAlong(nodes, (time * 0.48) % 1);
      return [
        {
          angle: Math.atan2(packet.y - 100, packet.x - 100),
          amount: 6.2,
          width: 0.50,
        },
      ];
    }

    case "tuning": {
      const xA = 62 + sin01(time, 2.6) * 76;
      const xB = 62 + sin01(time, 3.0, 1.7) * 76;
      return [
        {
          angle: Math.atan2(126 - 100, xA - 100),
          amount: 4.8,
          width: 0.34,
        },
        {
          angle: Math.atan2(145 - 100, xB - 100),
          amount: 4.3,
          width: 0.34,
        },
      ];
    }

    case "security": {
      return [
        { angle: Math.PI - 0.38, amount: 3.6, width: 0.46 },
        { angle: 0.38, amount: 3.6, width: 0.46 },
        { angle: Math.PI / 2, amount: 3.8, width: 0.30 },
      ];
    }
  }
};

const buildIntent = (
  specialist: SlimeSpecialist,
  state: SlimeState,
  time: number,
): Intent => {
  const sequence = sequenceFor(specialist, state);
  const sample = sampleSequence(
    sequence,
    time,
    specialistPhase(specialist),
  );
  const pose = sample.pose;

  const seed = 17.29 + specialistPhase(specialist) * 3.7;
  const ms = time * 1000;

  /**
   * Mesmo tipo de irregularidade do slowDrift do Avatar Lab:
   * mudanças de baixa frequência em intervalos diferentes por eixo.
   */
  const driftX = smoothNoise(ms, 0, seed, 2600) * 1.9;
  const driftY = smoothNoise(ms, 1, seed, 3300) * 1.7;
  const driftZ = smoothNoise(ms, 2, seed, 4100) * 1.1;

  const yaw = pose.y;
  const pitch = pose.x;
  const roll = pose.z;

  const yawNorm = clamp(yaw / 35, -1, 1);
  const pitchNorm = clamp(pitch / 24, -1, 1);

  /**
   * Esta é a principal diferença visual da V9:
   * headX/headY não movem só os olhos; deslocam e deformam a MASSA.
   */
  let cx = 100 + yaw * 0.27 + driftX;
  let cy = 100 + pitch * 0.19 + driftY;
  let sx =
    1 +
    Math.abs(yawNorm) * 0.055 -
    Math.max(0, pitchNorm) * 0.018;
  let sy =
    1 +
    Math.abs(pitchNorm) * 0.050 -
    Math.abs(yawNorm) * 0.022;
  let rotate = roll * 0.56 + driftZ;

  const transitionEnergy =
    sample.phase === "transition"
      ? Math.sin(sample.transitionProgress * Math.PI)
      : 0;

  /**
   * Na troca de expressão o slime dá uma reação visível: squash/stretch curto.
   */
  sx += transitionEnergy * 0.045;
  sy -= transitionEnergy * 0.030;
  cy -= transitionEnergy * 1.6;

  if (state === "waiting") {
    cy += 8;
    sx *= 1.08;
    sy *= 0.84;
    rotate *= 0.35;
  } else if (state === "owner") {
    cy -= 3;
    sx *= 1.025;
    sy *= 1.04;
  } else if (state === "completed") {
    const pop = Math.max(0, Math.sin(time * 2.2)) * 0.035;
    sx += pop;
    sy += pop * 1.35;
    cy -= pop * 55;
  }

  if (state === "working") {
    switch (specialist) {
      case "code":
        cy += 2.5;
        sy *= 1.025;
        break;
      case "data":
        sy *= 1.035;
        sx *= 0.985;
        break;
      case "design":
        rotate += wave(time, 1.25) * 2.8;
        break;
      case "agent":
        sx *= 1.02;
        sy *= 0.985;
        break;
      case "flow":
        sx *= 1.055;
        sy *= 0.955;
        break;
      case "tuning":
        cy += 1.5;
        break;
      case "security":
        sx *= 1.065;
        sy *= 0.95;
        cy += 1.5;
        break;
      case "chat":
        break;
    }
  }

  const orientationAngle = Math.atan2(
    pitchNorm * 0.8,
    yawNorm || 0.0001,
  );

  const pressures: Pressure[] = [
    /**
     * Leading edge bulge + trailing compression.
     * Mesmo uma esfera "vira slime" quando muda de pose.
     */
    {
      angle: orientationAngle,
      amount:
        5.8 * Math.hypot(yawNorm, pitchNorm) +
        transitionEnergy * 5.2,
      width: 0.72,
    },
    {
      angle: orientationAngle + Math.PI,
      amount:
        -3.7 * Math.hypot(yawNorm, pitchNorm) -
        transitionEnergy * 2.6,
      width: 0.86,
    },
    ...reactivePressures(specialist, state, time),
  ];

  return {
    cx,
    cy,
    sx,
    sy,
    rotate,
    pressures,
    gazeX: yaw * 0.17 + driftX * 0.45,
    gazeY: pitch * 0.13 + driftY * 0.35,
    gazeRotate: roll * 0.23,
    gazeScaleX:
      1.0 + Math.abs(yawNorm) * 0.055,
    gazeScaleY:
      state === "waiting"
        ? 0.82
        : 1.0 - Math.abs(pitchNorm) * 0.035,
    gradientX: 34 - yawNorm * 12,
    gradientY: 25 - pitchNorm * 9,
    transitionEnergy,
  };
};

export class GrokSlimeCore {
  private readonly svg: SVGSVGElement;
  private readonly group: SVGGElement;
  private readonly path: SVGPathElement;
  private readonly highlight: SVGPathElement;
  private readonly shadow: SVGEllipseElement;
  private readonly gradient: SVGRadialGradientElement;
  private readonly avatarHost: HTMLElement;
  private readonly eyesRoot: SVGGElement | null;

  private readonly radial: Spring[] = Array.from(
    { length: POINT_COUNT },
    () => spring(0),
  );

  private readonly centerX = spring(100);
  private readonly centerY = spring(100);
  private readonly scaleX = spring(1);
  private readonly scaleY = spring(1);
  private readonly rotation = spring(0);

  private readonly gazeX = spring(0);
  private readonly gazeY = spring(0);
  private readonly gazeRotate = spring(0);
  private readonly gazeScaleX = spring(1);
  private readonly gazeScaleY = spring(1);

  private previousTargetX = 100;
  private previousTargetY = 100;
  private previousVelocityX = 0;
  private previousVelocityY = 0;

  /**
   * O primeiro quadro não tem velocidade — ele tem um alvo.
   *
   * Sem isto, a distância entre o palpite inicial (100,100) e o alvo da primeira
   * pose é dividida por 1/240 s e vira velocidade: o motor inventa movimento a
   * partir de um valor que nunca observou.
   *
   * MEDIDO, para não superestimar o conserto: hoje isso não muda a tela. Varri
   * os 40 pares especialista/estado comparando o pico de deformação dos 25
   * primeiros quadros com e sem esta guarda, e a pior diferença foi 1,7% — as
   * sequências começam todas perto do centro. A guarda fica porque a conta sem
   * ela é infundada, não porque haja solavanco visível para tirar.
   */
  private primed = false;

  private destroyed = false;

  constructor(options: GrokSlimeOptions) {
    this.svg = options.svg;
    this.avatarHost = options.avatarHost;

    const bodyColor = options.bodyColor ?? "#000000";
    const id = `grok-slime-v9-${Math.random().toString(36).slice(2)}`;

    const defs =
      this.svg.querySelector("defs") ??
      this.svg.insertBefore(makeSvg("defs"), this.svg.firstChild);

    this.gradient = makeSvg("radialGradient", {
      id,
      cx: "34%",
      cy: "25%",
      r: "85%",
    });
    this.gradient.append(
      makeSvg("stop", { offset: "0%", "stop-color": "#303137" }),
      makeSvg("stop", { offset: "31%", "stop-color": "#111114" }),
      makeSvg("stop", { offset: "72%", "stop-color": "#050506" }),
      makeSvg("stop", { offset: "100%", "stop-color": bodyColor }),
    );
    defs.appendChild(this.gradient);

    this.group = makeSvg("g", {
      "data-grok-slime-core": "v9",
    });

    this.shadow = makeSvg("ellipse", {
      cx: 100,
      cy: 171,
      rx: 45,
      ry: 6.5,
      fill: "#000000",
      opacity: 0.28,
    });

    this.path = makeSvg("path", {
      fill: `url(#${id})`,
      stroke: "#36383e",
      "stroke-width": 1.1,
    });

    this.highlight = makeSvg("path", {
      fill: "none",
      stroke: "#ffffff",
      "stroke-width": 1.1,
      opacity: 0.12,
      "stroke-linecap": "round",
    });

    this.group.append(this.shadow, this.path, this.highlight);

    if (options.before && options.before.parentNode === this.svg) {
      this.svg.insertBefore(this.group, options.before);
    } else {
      this.svg.appendChild(this.group);
    }

    this.hideOriginalBody();

    this.eyesRoot =
      this.avatarHost.querySelector<SVGGElement>(
        '[data-grok-eyes-root="true"]',
      );
  }

  update(input: GrokSlimeUpdate): void {
    if (this.destroyed) return;

    /**
     * O piso era 0.65, e com ele `deformation: 0` — documentado como "nenhuma"
     * na opção pública do wrapper — entregava 65% da deformação. Opção aceita e
     * ignorada é a classe de bug que já custou tempo neste projeto: quem
     * desligasse a deformação (por acessibilidade, ou para a lista de 26px)
     * acreditaria ter desligado.
     *
     * Zero desliga a DEFORMAÇÃO — as pressões do ofício, o slosh, o impulso e o
     * wobble da borda. Não desliga o MOVIMENTO: o corpo continua deslocando,
     * inclinando e respirando, porque isso é a pose da cabeça, não deformação.
     */
    const strength = clamp(input.strength ?? 1, 0, 1.55);
    const intent = buildIntent(
      input.specialist,
      input.state,
      input.time,
    );

    /**
     * Calcula aceleração do alvo: quando a cabeça troca de direção, a massa
     * interna recebe um impulso e continua se mexendo após o alvo parar.
     */
    const safeDt = Math.max(1 / 240, clamp(input.dt, 0, 0.05));

    if (!this.primed) {
      this.primed = true;
      this.previousTargetX = intent.cx;
      this.previousTargetY = intent.cy;
    }

    const targetVelocityX = (intent.cx - this.previousTargetX) / safeDt;
    const targetVelocityY = (intent.cy - this.previousTargetY) / safeDt;
    const accelerationX =
      (targetVelocityX - this.previousVelocityX) * safeDt;
    const accelerationY =
      (targetVelocityY - this.previousVelocityY) * safeDt;

    this.previousTargetX = intent.cx;
    this.previousTargetY = intent.cy;
    this.previousVelocityX = targetVelocityX;
    this.previousVelocityY = targetVelocityY;

    stepSpring(this.centerX, intent.cx, input.dt, 135, 9.5);
    stepSpring(this.centerY, intent.cy, input.dt, 135, 9.5);
    stepSpring(this.scaleX, intent.sx, input.dt, 145, 10.0);
    stepSpring(this.scaleY, intent.sy, input.dt, 145, 10.0);
    stepSpring(this.rotation, intent.rotate, input.dt, 135, 9.2);

    stepSpring(this.gazeX, intent.gazeX, input.dt, 210, 15);
    stepSpring(this.gazeY, intent.gazeY, input.dt, 210, 15);
    stepSpring(this.gazeRotate, intent.gazeRotate, input.dt, 205, 15);
    stepSpring(this.gazeScaleX, intent.gazeScaleX, input.dt, 205, 15);
    stepSpring(this.gazeScaleY, intent.gazeScaleY, input.dt, 205, 15);

    const rawTargets: number[] = [];

    const velocityAngle = Math.atan2(
      targetVelocityY,
      targetVelocityX || 0.0001,
    );
    const velocityMagnitude = clamp(
      Math.hypot(targetVelocityX, targetVelocityY) / 1200,
      0,
      1,
    );

    const accelerationAngle = Math.atan2(
      accelerationY,
      accelerationX || 0.0001,
    );
    const accelerationMagnitude = clamp(
      Math.hypot(accelerationX, accelerationY) / 9,
      0,
      1,
    );

    for (let index = 0; index < POINT_COUNT; index++) {
      const angle = (index / POINT_COUNT) * TAU - Math.PI / 2;

      let target = 0;

      for (const pressure of intent.pressures) {
        target +=
          gaussian(angle, pressure.angle, pressure.width) *
          pressure.amount *
          strength;
      }

      /**
       * Slosh real: borda oposta ao movimento atrasa e depois ultrapassa.
       */
      target +=
        gaussian(angle, velocityAngle + Math.PI, 0.68) *
        velocityMagnitude *
        7.5 *
        strength;

      target -=
        gaussian(angle, velocityAngle, 0.72) *
        velocityMagnitude *
        3.5 *
        strength;

      /**
       * Impulso curto na troca brusca de pose.
       */
      target +=
        gaussian(angle, accelerationAngle + Math.PI, 0.60) *
        accelerationMagnitude *
        5.0 *
        strength;

      /**
       * Capillary wobble: pequeno mas rápido o bastante para aparecer em vídeo.
       */
      target +=
        (wave(input.time, 2.1, index * 0.37) * 0.75 +
          wave(input.time, 1.22, index * 0.21 + 1.4) * 0.42) *
        strength;

      rawTargets.push(target);
    }

    const mean =
      rawTargets.reduce((sum, value) => sum + value, 0) /
      rawTargets.length;

    const centered = rawTargets.map(
      (value) => value - mean * 0.91,
    );

    /**
     * Blur angular 5-tap: deixa a borda líquida sem criar pontas.
     */
    const smoothed = centered.map((value, index) => {
      const p2 =
        centered[(index - 2 + POINT_COUNT) % POINT_COUNT]!;
      const p1 =
        centered[(index - 1 + POINT_COUNT) % POINT_COUNT]!;
      const n1 =
        centered[(index + 1) % POINT_COUNT]!;
      const n2 =
        centered[(index + 2) % POINT_COUNT]!;

      return (
        value * 0.42 +
        (p1 + n1) * 0.21 +
        (p2 + n2) * 0.08
      );
    });

    for (let index = 0; index < POINT_COUNT; index++) {
      stepSpring(
        this.radial[index]!,
        smoothed[index] ?? 0,
        input.dt,
        input.state === "working" ? 170 : 120,
        input.state === "working" ? 10.0 : 11.5,
      );
    }

    this.gradient.setAttribute(
      "cx",
      `${clamp(intent.gradientX, 17, 53).toFixed(1)}%`,
    );
    this.gradient.setAttribute(
      "cy",
      `${clamp(intent.gradientY, 12, 43).toFixed(1)}%`,
    );

    this.render(input.state);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.group.remove();
    if (this.eyesRoot) this.eyesRoot.removeAttribute("transform");
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

  private render(state: SlimeState): void {
    const points: Point[] = [];
    const rotation = (this.rotation.value * Math.PI) / 180;
    const cosR = Math.cos(rotation);
    const sinR = Math.sin(rotation);

    const baseRadius = 58.5;

    for (let index = 0; index < POINT_COUNT; index++) {
      const angle = (index / POINT_COUNT) * TAU - Math.PI / 2;
      const radial = this.radial[index]!.value;

      const radiusX =
        (baseRadius + radial) * this.scaleX.value;
      const radiusY =
        (baseRadius + radial * 0.88) * this.scaleY.value;

      let x = Math.cos(angle) * radiusX;
      let y = Math.sin(angle) * radiusY;

      /**
       * Base com peso, mas não achatada.
       * Faz o corpo parecer material, não um círculo vetorial.
       */
      const bottom = Math.max(0, Math.sin(angle));
      y -= bottom * 1.8;

      const xr = x * cosR - y * sinR;
      const yr = x * sinR + y * cosR;

      points.push({
        x: this.centerX.value + xr,
        y: this.centerY.value + yr,
      });
    }

    this.path.setAttribute("d", closedSpline(points));

    // O índice 0 é o topo (o ângulo começa em -PI/2), então a varredura de
    // -SPAN a +SPAN sai naturalmente da esquerda para a direita, passando pelo
    // alto — e gira junto com o corpo, porque os pontos já vêm rotacionados.
    const highlightPoints: Point[] = [];
    for (let offset = -HIGHLIGHT_SPAN; offset <= HIGHLIGHT_SPAN; offset++) {
      highlightPoints.push(points[(offset + POINT_COUNT) % POINT_COUNT]!);
    }

    this.highlight.setAttribute("d", highlightSpline(highlightPoints));

    let minX = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const point of points) {
      minX = Math.min(minX, point.x);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    }

    const width = maxX - minX;

    this.shadow.setAttribute(
      "cx",
      this.centerX.value.toFixed(2),
    );
    this.shadow.setAttribute(
      "cy",
      Math.min(190, maxY + 10).toFixed(2),
    );
    this.shadow.setAttribute(
      "rx",
      clamp(width * 0.37, 27, 62).toFixed(2),
    );
    this.shadow.setAttribute(
      "ry",
      (state === "waiting" ? 5.0 : 6.5).toFixed(2),
    );

    if (this.eyesRoot) {
      this.eyesRoot.setAttribute(
        "transform",
        `translate(${(this.gazeX.value * STAGE_TO_EYE).toFixed(2)} ` +
          `${(this.gazeY.value * STAGE_TO_EYE).toFixed(2)}) ` +
          `rotate(${this.gazeRotate.value.toFixed(2)} 0 0) ` +
          `scale(${this.gazeScaleX.value.toFixed(3)} ` +
          `${this.gazeScaleY.value.toFixed(3)})`,
      );
    }
  }
}
