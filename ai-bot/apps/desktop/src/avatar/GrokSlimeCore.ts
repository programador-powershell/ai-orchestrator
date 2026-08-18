/**
 * GrokSlimeCore.ts
 *
 * Motor de corpo/slime separado da animação profissional.
 *
 * Objetivo:
 * - preservar a animação de especialidade já existente no projeto;
 * - substituir apenas o "boneco/ovo/metaball" por um único slime contínuo;
 * - a massa mantém volume aproximado e responde por pressão localizada;
 * - nenhuma especialidade cria um corpo completamente diferente;
 * - olhos continuam sendo renderizados pelo módulo de avatar/Avatar Lab.
 *
 * O desenho usa um path fechado com 40 pontos radiais e molas independentes.
 * A pressão profissional é pequena e local: ela faz a massa "ceder" para a
 * atividade sem transformar o personagem em polvo/tentáculo.
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

type Pressure = {
  angle: number;
  amount: number;
  width: number;
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
};

type Spring = {
  value: number;
  velocity: number;
};

type Point = {
  x: number;
  y: number;
};

const SVG_NS = "http://www.w3.org/2000/svg";
const TAU = Math.PI * 2;
const POINT_COUNT = 40;

/**
 * O avatar do stand-in usa viewBox 220 dentro de um host de 78% do stage.
 * 0.78 * 200 / 220 ~= .709.
 */
const STAGE_TO_EYE = 1 / 0.709;

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

const lerp = (a: number, b: number, t: number): number =>
  a + (b - a) * t;

const wave = (time: number, speed = 1, phase = 0): number =>
  Math.sin(time * speed + phase);

const sin01 = (time: number, speed = 1, phase = 0): number =>
  0.5 + 0.5 * wave(time, speed, phase);

const pingPong = (time: number): number => {
  const p = ((time % 2) + 2) % 2;
  return p <= 1 ? p : 2 - p;
};

const smooth = (value: number): number => {
  const t = clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
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

const pointAlong = (
  points: readonly Point[],
  progress: number,
): Point => {
  if (points.length === 0) return { x: 100, y: 100 };
  if (points.length === 1) return points[0] ?? { x: 100, y: 100 };

  const p = clamp(progress, 0, 1) * (points.length - 1);
  const i = Math.min(points.length - 2, Math.floor(p));
  const local = p - i;
  const a = points[i]!;
  const b = points[i + 1]!;
  return {
    x: lerp(a.x, b.x, local),
    y: lerp(a.y, b.y, local),
  };
};

const spring = (value: number): Spring => ({ value, velocity: 0 });

const stepSpring = (
  s: Spring,
  target: number,
  dt: number,
  stiffness = 190,
  damping = 22,
): void => {
  const safeDt = clamp(dt, 0, 0.05);
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

const highlightSpline = (points: readonly Point[]): string => {
  const selected = points
    .filter((point) => point.y < 72 && point.x > 48 && point.x < 142)
    .sort((a, b) => a.x - b.x);

  if (selected.length < 2) return "";

  return (
    `M${selected[0]!.x.toFixed(2)} ${selected[0]!.y.toFixed(2)} ` +
    selected
      .slice(1)
      .map((point) => `L${point.x.toFixed(2)} ${point.y.toFixed(2)}`)
      .join(" ")
  );
};

const defaultIntent = (): Intent => ({
  cx: 100,
  cy: 100,
  sx: 1,
  sy: 1,
  rotate: 0,
  pressures: [],
  gazeX: 0,
  gazeY: 0,
  gazeRotate: 0,
  gazeScaleX: 1,
  gazeScaleY: 1,
});

/**
 * O profissional continua sendo explicado pela cena do Claude.
 * Aqui o corpo somente REAGE à mesma atividade.
 *
 * As amplitudes são deliberadamente menores do que nas versões anteriores:
 * o Grok-like slime precisa continuar sendo o mesmo personagem.
 */
const intentFor = (
  specialist: SlimeSpecialist,
  state: SlimeState,
  time: number,
  stateAge: number,
): Intent => {
  const intent = defaultIntent();

  // Movimento de vida: baixo, assimétrico e não periódico demais.
  const breathe = wave(time, 1.02) * 0.012;
  const driftX =
    wave(time, 0.43) * 0.55 +
    wave(time, 0.71, 1.7) * 0.24;
  const driftY =
    wave(time, 0.51, 0.9) * 0.42 +
    wave(time, 0.83, 2.1) * 0.20;

  intent.cx += driftX;
  intent.cy += driftY;
  intent.sx += breathe;
  intent.sy -= breathe * 0.7;

  if (state === "waiting") {
    intent.cy += 8;
    intent.sx *= 1.055;
    intent.sy *= 0.90;
    intent.rotate = -2.2 + wave(time, 0.42) * 0.5;
    intent.pressures.push(
      { angle: Math.PI, amount: 1.8, width: 0.72 },
      { angle: 0, amount: 2.6, width: 0.72 },
    );
    intent.gazeY = 3.2;
    intent.gazeRotate = -2;
    intent.gazeScaleY = 0.90;
    return intent;
  }

  if (state === "owner") {
    intent.cy -= 3.2;
    intent.sx *= 1.025;
    intent.sy *= 1.035;
    intent.pressures.push({
      angle: -Math.PI / 2,
      amount: 2.6,
      width: 0.72,
    });
    intent.gazeY = -1.3;
    return intent;
  }

  if (state === "completed") {
    // Um único "pop" seguido de settle — sem ficar quicando para sempre.
    const age = clamp(stateAge, 0, 1.8);
    const attack = age < 0.34 ? smooth(age / 0.34) : 1;
    const release =
      age <= 0.34 ? 1 : 1 - smooth((age - 0.34) / 1.1);
    const pop = clamp(attack * release, 0, 1);

    intent.cy -= pop * 3.8;
    intent.sx *= 1 + pop * 0.045;
    intent.sy *= 1 + pop * 0.065;
    intent.rotate = pop * 2.2;
    intent.gazeScaleX = 1 + pop * 0.05;
    intent.gazeScaleY = 1 + pop * 0.05;
    return intent;
  }

  if (state !== "working") {
    return intent;
  }

  switch (specialist) {
    case "chat": {
      const left = sin01(time, 2.4) > 0.5;
      const side = left ? -1 : 1;
      const talk = sin01(time, 6.0);

      intent.cx += side * (1.8 + talk * 1.2);
      intent.rotate = side * (1.4 + talk * 0.9);
      intent.pressures.push({
        angle: side < 0 ? Math.PI : 0,
        amount: 5.2 + talk * 2.8,
        width: 0.52,
      });
      // Compensa do outro lado para a massa parecer migrar, não crescer.
      intent.pressures.push({
        angle: side < 0 ? 0 : Math.PI,
        amount: -2.3,
        width: 0.78,
      });
      intent.gazeX = side * 4.2;
      intent.gazeRotate = side * 1.8;
      break;
    }

    case "code": {
      const tapL = Math.max(0, wave(time, 10));
      const tapR = Math.max(0, wave(time, 10, Math.PI));

      intent.cy += 3.0;
      intent.sx *= 0.97;
      intent.sy *= 1.035;
      intent.rotate = 2.2;
      intent.pressures.push(
        {
          angle: 2.02,
          amount: 3.0 + tapL * 3.0,
          width: 0.32,
        },
        {
          angle: 1.12,
          amount: 3.0 + tapR * 3.0,
          width: 0.32,
        },
      );
      intent.gazeY = 3.8;
      intent.gazeScaleY = 0.94;
      break;
    }

    case "data": {
      const points = [
        { x: 28, y: 119 },
        { x: 48, y: 105 },
        { x: 70, y: 114 },
        { x: 94, y: 87 },
        { x: 121, y: 99 },
        { x: 150, y: 70 },
        { x: 172, y: 80 },
      ];
      const current = pointAlong(points, pingPong(time * 0.7));
      const angle = Math.atan2(current.y - 100, current.x - 100);
      const horizontal = clamp((current.x - 100) / 72, -1, 1);
      const vertical = clamp((current.y - 100) / 72, -1, 1);

      intent.sx *= 0.985;
      intent.sy *= 1.035;
      intent.cx += horizontal * 1.4;
      intent.cy += vertical * 1.0;
      intent.rotate = horizontal * 1.8;
      intent.pressures.push({
        angle,
        amount: 6.6,
        width: 0.42,
      });
      intent.pressures.push({
        angle: angle + Math.PI,
        amount: -2.5,
        width: 0.74,
      });
      intent.gazeX = horizontal * 4.6;
      intent.gazeY = vertical * 3.0;
      break;
    }

    case "design": {
      const controlB = {
        x: 132 + wave(time, 1.6, 1) * 9,
        y: 168 + wave(time, 1.2, 2) * 8,
      };
      const angle = Math.atan2(controlB.y - 100, controlB.x - 100);
      const side = Math.sign(controlB.x - 100) || 1;

      intent.cx += side * 1.4;
      intent.rotate = side * 3.1;
      intent.pressures.push({
        angle,
        amount: 7.8,
        width: 0.39,
      });
      intent.pressures.push({
        angle: angle + Math.PI,
        amount: -2.8,
        width: 0.76,
      });
      intent.gazeX = side * 3.7;
      intent.gazeY = 2.1;
      intent.gazeRotate = side * 2.5;
      break;
    }

    case "agent": {
      // Brotos sutis: a cena já mostra os agentes. O corpo só pulsa a coordenação.
      for (let index = 0; index < 4; index++) {
        const phase = index / 4;
        const dispatch = sin01(time, 1.4, phase * TAU);
        const angle = time * 0.55 + phase * TAU;
        intent.pressures.push({
          angle,
          amount: 1.6 + dispatch * 2.4,
          width: 0.34,
        });
      }
      intent.sx *= 1.018;
      intent.sy *= 0.985;
      intent.gazeScaleX = 1.03;
      intent.gazeScaleY = 0.97;
      break;
    }

    case "flow": {
      const nodes = [
        { x: 24, y: 132 },
        { x: 66, y: 108 },
        { x: 111, y: 138 },
        { x: 162, y: 104 },
      ];
      const packet = pointAlong(nodes, (time * 0.48) % 1);
      const angle = Math.atan2(packet.y - 100, packet.x - 100);
      const direction = clamp((packet.x - 100) / 76, -1, 1);

      intent.sx *= 1.055;
      intent.sy *= 0.955;
      intent.cx += direction * 2.4;
      intent.rotate = direction * 1.5;
      intent.pressures.push({
        angle,
        amount: 6.0,
        width: 0.50,
      });
      intent.pressures.push({
        angle: angle + Math.PI,
        amount: -2.6,
        width: 0.80,
      });
      intent.gazeX = direction * 4.5;
      break;
    }

    case "tuning": {
      const xA = 62 + sin01(time, 2.6, 0) * 76;
      const xB = 62 + sin01(time, 3.0, 1.7) * 76;
      const targetA = { x: xA, y: 126 };
      const targetB = { x: xB, y: 145 };

      [targetA, targetB].forEach((target, index) => {
        const angle = Math.atan2(target.y - 100, target.x - 100);
        intent.pressures.push({
          angle,
          amount: index === 0 ? 4.7 : 4.2,
          width: 0.34,
        });
      });

      intent.cy += 1.8;
      intent.gazeY = 2.8;
      intent.gazeX = clamp(((xA + xB) / 2 - 100) / 20, -3.5, 3.5);
      break;
    }

    case "security": {
      const scan = pingPong(time * 1.15);

      intent.sx *= 1.07;
      intent.sy *= 0.95;
      intent.cy += 1.8;
      // Ombros firmes, base levemente afunilada: ainda slime, não ícone de escudo.
      intent.pressures.push(
        { angle: Math.PI - 0.38, amount: 3.2, width: 0.46 },
        { angle: 0.38, amount: 3.2, width: 0.46 },
        { angle: Math.PI / 2, amount: 3.4, width: 0.30 },
      );
      intent.gazeY = lerp(-1.4, 2.7, scan);
      intent.gazeScaleY = 0.93;
      break;
    }
  }

  return intent;
};

export class GrokSlimeCore {
  private readonly svg: SVGSVGElement;
  private readonly group: SVGGElement;
  private readonly path: SVGPathElement;
  private readonly highlight: SVGPathElement;
  private readonly shadow: SVGEllipseElement;
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

  private lastState: SlimeState | null = null;
  private stateStartedAt = 0;
  private destroyed = false;

  constructor(options: GrokSlimeOptions) {
    this.svg = options.svg;
    this.avatarHost = options.avatarHost;

    const bodyColor = options.bodyColor ?? "#000000";
    const id = `grok-slime-${Math.random().toString(36).slice(2)}`;

    const defs =
      this.svg.querySelector("defs") ??
      this.svg.insertBefore(makeSvg("defs"), this.svg.firstChild);

    const gradient = makeSvg("radialGradient", {
      id,
      cx: "34%",
      cy: "25%",
      r: "83%",
    });
    gradient.append(
      makeSvg("stop", { offset: "0%", "stop-color": "#28292d" }),
      makeSvg("stop", { offset: "39%", "stop-color": "#0b0b0c" }),
      makeSvg("stop", { offset: "100%", "stop-color": bodyColor }),
    );
    defs.appendChild(gradient);

    this.group = makeSvg("g", {
      "data-grok-slime-core": "true",
    });

    this.shadow = makeSvg("ellipse", {
      cx: 100,
      cy: 171,
      rx: 45,
      ry: 6.5,
      fill: "#000000",
      opacity: 0.26,
    });

    this.path = makeSvg("path", {
      fill: `url(#${id})`,
      stroke: "#34363b",
      "stroke-width": 1.05,
    });

    this.highlight = makeSvg("path", {
      fill: "none",
      stroke: "#ffffff",
      "stroke-width": 1.1,
      opacity: 0.11,
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

    if (this.lastState !== input.state) {
      this.lastState = input.state;
      this.stateStartedAt = input.time;
    }

    const stateAge = Math.max(0, input.time - this.stateStartedAt);
    const intent = intentFor(
      input.specialist,
      input.state,
      input.time,
      stateAge,
    );

    const strength = clamp(input.strength ?? 1, 0.4, 1.45);

    stepSpring(this.centerX, intent.cx, input.dt, 165, 21);
    stepSpring(this.centerY, intent.cy, input.dt, 165, 21);
    stepSpring(this.scaleX, 1 + (intent.sx - 1) * strength, input.dt, 175, 22);
    stepSpring(this.scaleY, 1 + (intent.sy - 1) * strength, input.dt, 175, 22);
    stepSpring(this.rotation, intent.rotate * strength, input.dt, 165, 21);

    stepSpring(this.gazeX, intent.gazeX, input.dt, 230, 25);
    stepSpring(this.gazeY, intent.gazeY, input.dt, 230, 25);
    stepSpring(this.gazeRotate, intent.gazeRotate, input.dt, 230, 25);
    stepSpring(this.gazeScaleX, intent.gazeScaleX, input.dt, 230, 25);
    stepSpring(this.gazeScaleY, intent.gazeScaleY, input.dt, 230, 25);

    const rawTargets: number[] = [];

    for (let index = 0; index < POINT_COUNT; index++) {
      const angle = (index / POINT_COUNT) * TAU - Math.PI / 2;

      let target = 0;

      for (const pressure of intent.pressures) {
        target +=
          gaussian(angle, pressure.angle, pressure.width) *
          pressure.amount *
          strength;
      }

      // Capillary motion: subpixel/low amplitude, only to avoid a dead vector path.
      target +=
        wave(input.time, 1.17, index * 0.31) * 0.32 +
        wave(input.time, 0.69, index * 0.19 + 1.8) * 0.20;

      rawTargets.push(target);
    }

    /**
     * Preservação aproximada de volume: pressão de um lado desloca massa em vez
     * de simplesmente inflar o personagem inteiro.
     */
    const mean =
      rawTargets.reduce((sum, value) => sum + value, 0) /
      rawTargets.length;

    const centered = rawTargets.map((value) => value - mean * 0.82);

    // Suavização angular para impedir pontas/tentáculos.
    const smoothed = centered.map((value, index) => {
      const prev = centered[(index - 1 + POINT_COUNT) % POINT_COUNT]!;
      const next = centered[(index + 1) % POINT_COUNT]!;
      return value * 0.58 + prev * 0.21 + next * 0.21;
    });

    for (let index = 0; index < POINT_COUNT; index++) {
      stepSpring(
        this.radial[index]!,
        smoothed[index] ?? 0,
        input.dt,
        input.state === "working" ? 205 : 150,
        input.state === "working" ? 22 : 24,
      );
    }

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
    const sx = this.scaleX.value;
    const sy = this.scaleY.value;

    for (let index = 0; index < POINT_COUNT; index++) {
      const angle = (index / POINT_COUNT) * TAU - Math.PI / 2;
      const radial = this.radial[index]!.value;

      const radiusX = (baseRadius + radial) * sx;
      const radiusY = (baseRadius + radial * 0.84) * sy;

      let x = Math.cos(angle) * radiusX;
      let y = Math.sin(angle) * radiusY;

      // Base um pouco mais pesada: mantém aspecto de slime sem virar poça.
      const bottom = Math.max(0, Math.sin(angle));
      y -= bottom * 1.2;

      const xr = x * cosR - y * sinR;
      const yr = x * sinR + y * cosR;

      points.push({
        x: this.centerX.value + xr,
        y: this.centerY.value + yr,
      });
    }

    this.path.setAttribute("d", closedSpline(points));
    this.highlight.setAttribute("d", highlightSpline(points));

    let minX = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const point of points) {
      minX = Math.min(minX, point.x);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    }

    const width = maxX - minX;
    this.shadow.setAttribute("cx", this.centerX.value.toFixed(2));
    this.shadow.setAttribute(
      "cy",
      Math.min(188, maxY + 10).toFixed(2),
    );
    this.shadow.setAttribute(
      "rx",
      clamp(width * 0.36, 28, 56).toFixed(2),
    );
    this.shadow.setAttribute(
      "ry",
      (state === "waiting" ? 5.2 : 6.3).toFixed(2),
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
