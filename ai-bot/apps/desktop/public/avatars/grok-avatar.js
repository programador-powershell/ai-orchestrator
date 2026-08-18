/**
 * STAND-IN do pacote de avatar exportado pelo Bible Strong Avatar Lab.
 *
 * O wrapper `grokSpecialistAvatar.ts` carrega ESTE arquivo por URL e espera a
 * interface do export JavaScript do Lab: `availableAnimations` + `createAvatar`.
 * Enquanto o pacote real (exportado do estúdio, pendente TI/SI pela licença
 * AGPL do Lab) não é colocado aqui, este stand-in PRÓPRIO — nenhuma linha veio
 * do Lab — responde pela mesma interface: a esfera preta de olhos brancos, com
 * as animações nomeadas que o wrapper conhece.
 *
 * Para trocar pelo export real: substitua este arquivo pelo módulo do pacote
 * baixado do Lab (mesmo caminho, mesma interface). Nada mais muda.
 */

export const availableAnimations = Object.freeze([
  "idle",
  "listening",
  "thinking",
  "working",
  "searching",
  "sleeping",
  "drowsy",
  "happy",
  "celebrate",
  "proud",
  "curious",
  "suspicious",
  "excited"
]);

const NS = "http://www.w3.org/2000/svg";
const TAU = Math.PI * 2;

/*
 * Uma animação é um alvo de pose + modulação temporal. A pose fala a língua
 * dos olhos: largura/altura (rx/ry), afastamento, altura no rosto, ângulo
 * espelhado (sorriso/tristeza/desconfiança), olhar (lookX/lookY) e o corpo
 * (bobAmp/bobSpeed, tilt, squashY).
 */
const POSES = {
  idle: { rx: 6, ry: 15, gap: 32, y: -4, angle: 0, lookAmp: 2.2, lookSpeed: 0.5, bobAmp: 2, bobSpeed: 0.5, blink: true },
  listening: { rx: 6.6, ry: 17, gap: 33, y: -7, angle: 0, lookAmp: 1.2, lookSpeed: 0.35, bobAmp: 1.4, bobSpeed: 0.4, blink: true },
  thinking: { rx: 5.6, ry: 13, gap: 31, y: -10, angle: -4, lookX: 7, lookAmp: 1.6, lookSpeed: 0.9, bobAmp: 1.6, bobSpeed: 0.7, blink: true },
  working: { rx: 6.4, ry: 9, gap: 33, y: -1, angle: -7, lookAmp: 5, lookSpeed: 3.4, bobAmp: 1.1, bobSpeed: 5.4, blink: true, jitter: 0.8 },
  searching: { rx: 6.8, ry: 15.5, gap: 32, y: -4, angle: 0, lookAmp: 9, lookSpeed: 1.7, bobAmp: 1.6, bobSpeed: 1.1, blink: true },
  sleeping: { rx: 8.6, ry: 1.6, gap: 30, y: 3, angle: 4, lookAmp: 0, lookSpeed: 0, bobAmp: 2.6, bobSpeed: 0.32, breathe: 0.02 },
  drowsy: { rx: 7.4, ry: 4.4, gap: 31, y: 1, angle: 3, lookAmp: 0.8, lookSpeed: 0.2, bobAmp: 2.2, bobSpeed: 0.36, breathe: 0.012, blink: true },
  happy: { rx: 8.2, ry: 5.2, gap: 31, y: -6, angle: 15, lookAmp: 1.2, lookSpeed: 0.5, bobAmp: 1.8, bobSpeed: 0.7 },
  celebrate: { rx: 8.2, ry: 5.6, gap: 31, y: -8, angle: 17, lookAmp: 1.4, lookSpeed: 0.8, bobAmp: 5.2, bobSpeed: 3.1, hop: true },
  proud: { rx: 6.2, ry: 17.5, gap: 33, y: -8, angle: 6, lookAmp: 1, lookSpeed: 0.3, bobAmp: 1.2, bobSpeed: 0.45, lift: -3, blink: true },
  curious: { rx: 7.4, ry: 16, gap: 34, y: -7, angle: -3, lookX: 6, lookAmp: 3.4, lookSpeed: 0.8, bobAmp: 2, bobSpeed: 0.6, tilt: 5, blink: true },
  suspicious: { rx: 7, ry: 6.5, gap: 33, y: -5, angle: -9, lookX: -5, lookAmp: 3.2, lookSpeed: 0.5, bobAmp: 1, bobSpeed: 0.4, blink: true },
  excited: { rx: 7.6, ry: 18.5, gap: 34, y: -6, angle: 4, lookAmp: 2.6, lookSpeed: 1.6, bobAmp: 4.2, bobSpeed: 2.6, blink: true }
};

let instancia = 0;

function el(tag, attrs) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, String(v));
  return node;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function createAvatar(target, options = {}) {
  const host = typeof target === "string" ? document.querySelector(target) : target;
  if (!host) throw new Error("createAvatar: alvo não encontrado");

  const uid = `gsl${(instancia += 1)}`;
  const size = options.size ?? 220;
  const svg = el("svg", { viewBox: "-110 -110 220 220", preserveAspectRatio: "xMidYMid meet" });
  svg.style.display = "block";
  svg.style.overflow = "visible";
  if (typeof size === "number") {
    svg.setAttribute("width", String(size));
    svg.setAttribute("height", String(size));
  } else {
    svg.style.width = size;
    svg.style.height = size;
  }

  const defs = el("defs", {});
  const grad = el("radialGradient", { id: `${uid}-body`, cx: "34%", cy: "26%", r: "78%" });
  grad.append(
    el("stop", { offset: "0%", "stop-color": "#26272b" }),
    el("stop", { offset: "45%", "stop-color": "#0a0b0c" }),
    el("stop", { offset: "100%", "stop-color": "#000000" })
  );
  defs.append(grad);

  const body = el("g", {});
  const sombra = el("ellipse", { cx: 0, cy: 92, rx: 62, ry: 12, fill: "#000", opacity: 0.4, "data-grok-shadow": "true" });
  const esfera = el("circle", { cx: 0, cy: 0, r: 84, fill: `url(#${uid}-body)`, stroke: "#34363b", "stroke-width": 1.2, "data-grok-body-shape": "true" });
  const brilho = el("path", {
    d: "M -58 -60 A 84 84 0 0 1 52 -66",
    fill: "none",
    stroke: "#ffffff",
    "stroke-width": 1.6,
    opacity: 0.15,
    "stroke-linecap": "round",
    "data-grok-body-highlight": "true"
  });
  const eyesRoot = el("g", { "data-grok-eyes-root": "true" });
  const olhoE = el("ellipse", { cx: -16, cy: -4, rx: 6, ry: 15, fill: "#fff", "data-grok-eye-left": "true" });
  const olhoD = el("ellipse", { cx: 16, cy: -4, rx: 6, ry: 15, fill: "#fff", "data-grok-eye-right": "true" });
  eyesRoot.append(olhoE, olhoD);
  body.append(esfera, brilho, eyesRoot);
  svg.append(defs, sombra, body);
  host.appendChild(svg);

  let atual = POSES[options.animation] ? options.animation : "idle";
  let raf = 0;
  let vivo = true;
  let pausado = !(options.autoplay ?? true);
  const inicio = typeof performance !== "undefined" ? performance.now() : 0;
  let proximaPiscada = inicio + 1600 + Math.random() * 2400;
  let piscadaEm = -1;

  // Pose corrente — mistura 12%/quadro para a troca de animação deslizar.
  const pose = { rx: 6, ry: 15, gap: 32, y: -4, angle: 0, lookX: 0, lookY: 0, bob: 0, tilt: 0, lift: 0, squash: 1 };

  function quadro(nowMs) {
    const p = POSES[atual] || POSES.idle;
    const t = (nowMs - inicio) / 1000;

    let ry = p.ry;
    if (p.blink) {
      if (nowMs >= proximaPiscada && piscadaEm < 0) piscadaEm = nowMs;
      if (piscadaEm >= 0) {
        const idade = nowMs - piscadaEm;
        if (idade > 240) {
          piscadaEm = -1;
          proximaPiscada = nowMs + 2200 + Math.random() * 2600;
        } else {
          const x = idade / 240;
          const fecha = x < 0.5 ? x * 2 : (1 - x) * 2;
          ry = lerp(ry, 1.4, Math.min(1, fecha * 1.2));
        }
      }
    }

    const jitter = p.jitter ? Math.sin(t * 37) * p.jitter : 0;
    const alvo = {
      rx: p.rx,
      ry,
      gap: p.gap,
      y: p.y,
      angle: p.angle,
      lookX: (p.lookX || 0) + Math.sin(t * TAU * (p.lookSpeed || 0)) * (p.lookAmp || 0) + jitter,
      lookY: Math.sin(t * TAU * (p.lookSpeed || 0) * 0.6 + 1.3) * ((p.lookAmp || 0) * 0.3),
      bob: Math.sin(t * TAU * (p.bobSpeed || 0)) * (p.bobAmp || 0) + (p.hop ? -Math.abs(Math.sin(t * TAU * 1.4)) * 6 : 0),
      tilt: (p.tilt || 0) * Math.sin(t * TAU * 0.22),
      lift: p.lift || 0,
      squash: 1 + (p.breathe ? Math.sin(t * TAU * 0.3) * p.breathe : 0)
    };

    for (const k of Object.keys(pose)) pose[k] = lerp(pose[k], alvo[k], 0.12);

    body.setAttribute(
      "transform",
      `translate(0 ${(pose.bob + pose.lift).toFixed(2)}) rotate(${pose.tilt.toFixed(2)}) scale(1 ${pose.squash.toFixed(4)})`
    );
    const meio = pose.gap / 2;
    const olhos = [
      [olhoE, -meio, 1],
      [olhoD, meio, -1]
    ];
    for (const [olho, cx, lado] of olhos) {
      const x = cx + pose.lookX;
      const y = pose.y + pose.lookY;
      olho.setAttribute("cx", x.toFixed(2));
      olho.setAttribute("cy", y.toFixed(2));
      olho.setAttribute("rx", Math.max(1.2, pose.rx).toFixed(2));
      olho.setAttribute("ry", Math.max(1.2, pose.ry).toFixed(2));
      // Ângulo espelhado: positivo sorri (cantos externos caem), negativo franze.
      olho.setAttribute("transform", `rotate(${(pose.angle * lado).toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)})`);
    }
  }

  function laco(now) {
    if (!vivo) return;
    if (!pausado) quadro(now);
    raf = requestAnimationFrame(laco);
  }

  const reduzido =
    typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const semRaf = typeof requestAnimationFrame !== "function";
  if (reduzido || semRaf) {
    quadro(inicio + 800);
  } else {
    raf = requestAnimationFrame(laco);
  }

  return {
    play(nome) {
      if (nome && POSES[nome]) atual = nome;
      pausado = false;
      if (reduzido || semRaf) quadro(inicio + 800);
      if (options.onAnimationEnd && (atual === "celebrate" || atual === "excited")) {
        setTimeout(() => options.onAnimationEnd && options.onAnimationEnd(), 2600);
      }
    },
    pause() {
      pausado = true;
    },
    stop() {
      pausado = true;
      atual = "idle";
    },
    destroy() {
      vivo = false;
      if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(raf);
      svg.remove();
    }
  };
}
