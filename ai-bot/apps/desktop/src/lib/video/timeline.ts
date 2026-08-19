/**
 * Linha do tempo do estúdio de Vídeo — modelo puro e operações imutáveis.
 *
 * Porta a parte SEM DOM da aba de vídeo do AI-Orchestrator
 * (modes/DesignView.tsx): a superfície (specialists/VideoStudio.tsx) fica só
 * com o que precisa de tela — player, ponteiro, teclado — e tudo que decide
 * corte roda em Node e é coberto por timeline.test.ts.
 *
 * As operações são imutáveis pelo mesmo motivo do canvasDoc: quem observa a
 * lista (zustand, React) compara por identidade — mutação in-place "muda sem
 * mudar" e a tela deixa de acompanhar o estado em silêncio. Operação que não
 * altera nada devolve a MESMA referência, para o set do store virar no-op.
 */

export type TransitionKind = "none" | "fade" | "wipeleft" | "wiperight" | "slideup" | "dissolve";

export type MediaKind = "video" | "image";

export interface VideoMedia {
  id: string;
  /**
   * Nome REAL do arquivo importado (ex.: "abertura.mp4"). É o que entra no
   * comando ffmpeg: o object URL do preview só existe dentro do navegador e
   * morre com a sessão — para o ffmpeg apenas o nome serve, resolvido como
   * caminho relativo à pasta que a pessoa confirma na exportação.
   */
  name: string;
  /** Vídeo vira clipe da trilha base; imagem só existe como overlay (logo). */
  kind: MediaKind;
  /** Em segundos. Imagem não tem duração: fica 0 e nunca vira clipe. */
  duration: number;
}

export interface VideoClip {
  id: string;
  mediaId: string;
  name: string;
  /** Entrada/saída em segundos DENTRO da mídia de origem, não da timeline. */
  start: number;
  end: number;
  /** Transição PARA O PRÓXIMO clipe. Ausente/none = emenda seca. */
  transition?: TransitionKind;
  /** Duração da transição, em segundos. */
  transitionDuration?: number;
}

export interface TextOverlay {
  id: string;
  text: string;
  /** Posição em pixels do vídeo FINAL (não da tela do preview). */
  x: number;
  y: number;
  fontSize: number;
  /** Cor no formato que o ffmpeg entende (`white`, `#ffffff`). */
  color: string;
  /** Janela em que o texto aparece, em segundos do vídeo final. */
  from: number;
  to: number;
}

export interface LogoOverlay {
  id: string;
  /** Mídia de IMAGEM importada — o logo/selo que fica por cima da base. */
  mediaId: string;
  x: number;
  y: number;
  /** Janela em segundos do vídeo final em que o logo aparece. */
  from: number;
  to: number;
}

/**
 * Nenhum clipe encolhe além disto: um décimo de segundo ainda é visível e
 * exportável; abaixo, o trim vira remoção acidental — e remoção tem botão
 * próprio, com intenção declarada.
 */
export const MIN_CLIP_SEC = 0.1;

/**
 * Margem do split: cortar a menos de 0,15s de uma borda produziria uma lasca
 * que nem toca nem exporta. Melhor recusar o corte do que criar lixo na
 * timeline — a pessoa mal veria o clipe novo e não entenderia de onde saiu.
 */
export const SPLIT_MARGIN_SEC = 0.15;

/* ------------------------------ leitura de tempo ------------------------- */

export const clipDuration = (clip: VideoClip): number => clip.end - clip.start;

export const totalDuration = (clips: readonly VideoClip[]): number =>
  clips.reduce((soma, clip) => soma + clipDuration(clip), 0);

/** Onde cada clipe COMEÇA na linha do tempo acumulada. */
export function clipOffsets(clips: readonly VideoClip[]): number[] {
  let acumulado = 0;
  return clips.map((clip) => {
    const offset = acumulado;
    acumulado += clipDuration(clip);
    return offset;
  });
}

/**
 * O clipe sob um instante da timeline, com o tempo INTERNO dele. O instante é
 * grampeado em [0, total): pedir além do fim devolve o último clipe — é o que
 * o transporte do player precisa para não cair num índice inexistente.
 */
export function clipAt(
  clips: readonly VideoClip[],
  time: number
): { index: number; inner: number } | null {
  if (clips.length === 0) return null;
  const total = totalDuration(clips);
  const clamped = Math.max(0, Math.min(time, Math.max(0, total - 0.001)));
  const offsets = clipOffsets(clips);
  for (let i = 0; i < clips.length; i += 1) {
    const clip = clips[i];
    const offset = offsets[i];
    if (clip === undefined || offset === undefined) continue;
    if (clamped < offset + clipDuration(clip)) return { index: i, inner: clamped - offset };
  }
  // Só alcançável com total 0 (todo clipe é validado com duração positiva na
  // exportação, mas o modelo não proíbe): devolve o último com inner 0.
  return { index: clips.length - 1, inner: 0 };
}

export function formatTime(seconds: number): string {
  const safe = Math.max(0, seconds);
  const minutes = Math.floor(safe / 60);
  const rest = safe - minutes * 60;
  return `${minutes}:${rest.toFixed(1).padStart(4, "0")}`;
}

/** Passo da régua: ~10 marcações independentemente do total. */
export function tickStep(total: number): number {
  for (const step of [0.5, 1, 2, 5, 10, 15, 30, 60, 120]) {
    if (total / step <= 10) return step;
  }
  return 300;
}

export function buildTicks(total: number): number[] {
  if (total <= 0) return [];
  const step = tickStep(total);
  const ticks: number[] = [];
  for (let t = 0; t <= total + 0.001; t += step) ticks.push(Math.round(t * 10) / 10);
  return ticks;
}

/* --------------------------- operações imutáveis ------------------------- */

/**
 * Acrescenta um clipe cobrindo a mídia INTEIRA — o corte vem depois, por
 * split/trim. Imagem não entra: ela não tem linha do tempo própria e vira
 * overlay (LogoOverlay), nunca clipe de base.
 */
export function addClip(clips: readonly VideoClip[], media: VideoMedia, id: string): VideoClip[] {
  if (media.kind !== "video" || !(media.duration > 0)) return clips as VideoClip[];
  return [
    ...clips,
    {
      id,
      mediaId: media.id,
      // O nome do clipe perde a extensão: na timeline ele é um trecho, não um
      // arquivo — o arquivo continua inteiro na lista de mídia.
      name: media.name.replace(/\.[^.]+$/, ""),
      start: 0,
      end: media.duration
    }
  ];
}

/**
 * Divide o clipe sob o instante da TIMELINE em dois. Sem corte possível
 * (margem de borda, timeline vazia) devolve a mesma referência.
 */
export function splitClipAt(clips: readonly VideoClip[], time: number, newId: string): VideoClip[] {
  const offsets = clipOffsets(clips);
  for (let i = 0; i < clips.length; i += 1) {
    const clip = clips[i];
    const offset = offsets[i];
    if (clip === undefined || offset === undefined) continue;
    const inner = time - offset;
    if (inner > SPLIT_MARGIN_SEC && inner < clipDuration(clip) - SPLIT_MARGIN_SEC) {
      const corte = clip.start + inner;
      // A metade ESQUERDA nasce sem transição de propósito: a transição
      // pendura na emenda com o PRÓXIMO clipe, e depois do corte o próximo da
      // esquerda é a metade direita — herdá-la daria à emenda interna um fade
      // que ninguém pediu. A direita herda tudo: a emenda dela com o clipe
      // seguinte é a mesma de antes do corte.
      const esquerda: VideoClip = {
        id: clip.id,
        mediaId: clip.mediaId,
        name: `${clip.name} · A`,
        start: clip.start,
        end: corte
      };
      const direita: VideoClip = { ...clip, id: newId, name: `${clip.name} · B`, start: corte };
      return [...clips.slice(0, i), esquerda, direita, ...clips.slice(i + 1)];
    }
  }
  return clips as VideoClip[];
}

/**
 * Apara as bordas (in/out) com grampo: dentro da mídia, com pelo menos
 * MIN_CLIP_SEC de duração. Mídia de duração desconhecida (0) não deixa o
 * clipe ESTICAR além do que já era — encolher sempre pode.
 */
export function trimClip(
  clips: readonly VideoClip[],
  id: string,
  patch: { start?: number; end?: number },
  mediaDuration: number
): VideoClip[] {
  const index = clips.findIndex((clip) => clip.id === id);
  const clip = index >= 0 ? clips[index] : undefined;
  if (clip === undefined) return clips as VideoClip[];
  const limite = mediaDuration > 0 ? mediaDuration : clip.end;
  let start = patch.start ?? clip.start;
  let end = patch.end ?? clip.end;
  start = Math.min(Math.max(0, start), limite - MIN_CLIP_SEC);
  end = Math.min(Math.max(start + MIN_CLIP_SEC, end), limite);
  if (start === clip.start && end === clip.end) return clips as VideoClip[];
  const next = [...clips];
  next[index] = { ...clip, start, end };
  return next;
}

export function removeClip(clips: readonly VideoClip[], id: string): VideoClip[] {
  const next = clips.filter((clip) => clip.id !== id);
  return next.length === clips.length ? (clips as VideoClip[]) : next;
}

/**
 * Move o clipe para o índice pedido (grampeado). Reordenar muda as EMENDAS:
 * a transição continua pendurada no clipe que a carrega — é a regra mais
 * previsível: quem move o clipe leva a transição de saída dele junto.
 */
export function moveClip(clips: readonly VideoClip[], id: string, to: number): VideoClip[] {
  const from = clips.findIndex((clip) => clip.id === id);
  if (from < 0) return clips as VideoClip[];
  const destino = Math.max(0, Math.min(clips.length - 1, to));
  if (destino === from) return clips as VideoClip[];
  const next = [...clips];
  const [movido] = next.splice(from, 1);
  if (movido === undefined) return clips as VideoClip[];
  next.splice(destino, 0, movido);
  return next;
}
