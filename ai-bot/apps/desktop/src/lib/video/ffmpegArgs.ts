/**
 * Montagem do comando ffmpeg do estúdio de Vídeo — como LISTA de argumentos.
 *
 * Portado do AI-Orchestrator (lib/videoCompose.ts) com UMA diferença de
 * contrato, que é decisão de segurança da casa: aqui a UI NÃO executa nada.
 * O plano sai como lista de args (`string[]`), nunca string de shell — quem
 * cita para exibição é `formatFfmpegArgs`, e quem RODA é o agente, num turno
 * que passa pelo portão de aprovação. Montar string aqui misturaria os dois
 * níveis (dados e shell) e reabriria a injeção por nome de arquivo.
 *
 * O que fica igual ao orquestrador, porque foi verificado lá renderizando
 * quadro (não deduzido):
 *
 * - a aritmética de offset do `xfade` — onde quase toda implementação erra;
 * - o escape do `drawtext`, com seus DOIS níveis de parser e o apóstrofo sem
 *   escape possível;
 * - as recusas: comando frágil que falha no meio da renderização custa mais
 *   que uma recusa clara na hora de montar.
 *
 * Continua puro: monta, não executa. Coberto por ffmpegArgs.test.ts.
 */

import type { LogoOverlay, TextOverlay, TransitionKind, VideoClip, VideoMedia } from "./timeline";

/** Nome do filtro `xfade` para cada transição oferecida na UI. */
const XFADE_NAME: Record<Exclude<TransitionKind, "none">, string> = {
  fade: "fade",
  wipeleft: "wipeleft",
  wiperight: "wiperight",
  slideup: "slideup",
  dissolve: "dissolve"
};

export interface FfmpegOptions {
  output?: string;
  withAudio?: boolean;
  texts?: TextOverlay[];
  logos?: LogoOverlay[];
  /**
   * Fonte para o `drawtext`.
   *
   * No Windows o ffmpeg quase nunca vem com fontconfig, então `font=Arial`
   * falha e só o caminho do arquivo (`C:/Windows/Fonts/arial.ttf`) funciona.
   */
  fontFile?: string;
}

export interface FfmpegPlan {
  ok: boolean;
  /**
   * O comando como lista de argumentos (sem o executável `ffmpeg` na frente).
   * NUNCA uma string de shell: a citação para exibição é responsabilidade de
   * `formatFfmpegArgs`, e a execução é do agente com aprovação.
   */
  args: string[];
  reason?: string;
  output: string;
  /** Duração final estimada — encurta a cada transição. */
  durationSec: number;
  /** Avisos que não impedem a exportação, mas a pessoa precisa ler. */
  warnings: string[];
}

/**
 * Aspas ou quebra de linha no nome escapariam da citação quando o comando é
 * exibido/rodado como texto. A lista de args protege a MONTAGEM, mas o
 * destino final é o composer — texto — então a recusa continua obrigatória.
 */
function unsafeName(name: string): boolean {
  return /["\r\n]/.test(name) || name.trim().length === 0;
}

/**
 * Prepara o texto para dentro do `drawtext`.
 *
 * O ffmpeg desescapa em DOIS níveis: o parser do filtergraph corta em `:` e
 * `;` respeitando `'…'`, e só depois o parser de opção desescapa `\x`. Por
 * isso `\:` e `\%` funcionam — atravessam o primeiro nível intactos.
 *
 * O apóstrofo é o caso que não tem escape que preste. **Dentro** das aspas a
 * barra invertida não escapa nada, então `\'` fecha a seção e o resto do
 * comando vira texto; e `'\''` também não resolve — verificado renderizando um
 * quadro, não deduzido: a aspas reaberta engole `:x=…:fontsize=…` para dentro
 * da legenda. A saída é não ter apóstrofo reto nenhum: ele vira o tipográfico
 * `’`, que desenha certo (melhor, tipograficamente) e não significa nada para
 * o parser. Zero superfície de injeção, em vez de um escape que quase funciona.
 */
export function escapeDrawText(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "’")
    .replace(/:/g, "\\:")
    .replace(/%/g, "\\%")
    .replace(/[\r\n]+/g, " ");
}

const seconds = (value: number) => value.toFixed(3).replace(/\.?0+$/, "") || "0";

/**
 * Offset de cada transição na linha do tempo acumulada.
 *
 * A conta que quase todo mundo erra: no `xfade`, `offset` é medido no vídeo
 * JÁ CONCATENADO, e cada transição **encurta** o resultado pela sua duração
 * (os dois clipes se sobrepõem). Usar a soma crua das durações faz a segunda
 * transição em diante cair no lugar errado — e o defeito só aparece a partir
 * do terceiro clipe, que é por que passa despercebido.
 */
export function xfadeOffsets(durations: readonly number[], transitions: readonly number[]): number[] {
  const offsets: number[] = [];
  let acumulado = 0;
  for (let i = 0; i < durations.length - 1; i += 1) {
    const duracaoTransicao = transitions[i] ?? 0;
    acumulado += durations[i] ?? 0;
    // O ponto de início da transição é o fim do trecho acumulado MENOS a
    // duração dela, porque a sobreposição já começou.
    offsets.push(Math.max(0, acumulado - duracaoTransicao));
    acumulado -= duracaoTransicao;
  }
  return offsets;
}

/** Duração final: a soma dos clipes menos o que cada transição sobrepõe. */
export function composedDuration(durations: readonly number[], transitions: readonly number[]): number {
  const total = durations.reduce((soma, valor) => soma + valor, 0);
  const sobreposto = transitions
    .slice(0, Math.max(0, durations.length - 1))
    .reduce((soma, valor) => soma + valor, 0);
  return Math.max(0, total - sobreposto);
}

/**
 * Monta o plano de exportação.
 *
 * Recusa em vez de gerar comando frágil — um ffmpeg que falha no meio da
 * renderização custa mais tempo (do agente e da pessoa que aprovou) que uma
 * recusa clara na hora de montar.
 */
export function buildFfmpegArgs(
  clips: readonly VideoClip[],
  media: readonly VideoMedia[],
  options: FfmpegOptions = {}
): FfmpegPlan {
  const output = (options.output ?? "corte-final.mp4").trim() || "corte-final.mp4";
  const vazio: FfmpegPlan = { ok: false, args: [], output, durationSec: 0, warnings: [] };
  if (unsafeName(output)) return { ...vazio, reason: "Nome de saída inválido." };
  if (clips.length === 0) {
    return { ...vazio, reason: "A timeline está vazia — adicione ao menos um clipe." };
  }

  const byId = new Map(media.map((item) => [item.id, item]));
  const warnings: string[] = [];

  // Um `-i` por mídia usada, em ordem estável; imagem entra com `-loop 1` (ver
  // o bloco dos logos). O índice conta TODAS as entradas, vídeo e imagem.
  const inputArgs: string[] = [];
  const inputIndex = new Map<string, number>();
  let totalInputs = 0;
  for (const clip of clips) {
    const source = byId.get(clip.mediaId);
    if (!source) return { ...vazio, reason: "Um clipe aponta para mídia que não está mais importada." };
    if (source.kind !== "video") return { ...vazio, reason: `Imagem não vira clipe da trilha base: ${source.name}` };
    if (!(clip.end > clip.start)) return { ...vazio, reason: "Todo clipe precisa de duração positiva." };
    if (unsafeName(source.name)) return { ...vazio, reason: `Nome de arquivo inseguro: ${source.name}` };
    if (!inputIndex.has(clip.mediaId)) {
      inputIndex.set(clip.mediaId, totalInputs);
      totalInputs += 1;
      inputArgs.push("-i", source.name);
    }
  }

  const logos = options.logos ?? [];
  for (const logo of logos) {
    const source = byId.get(logo.mediaId);
    if (!source) return { ...vazio, reason: "Um logo aponta para imagem que não está mais importada." };
    if (source.kind !== "image") return { ...vazio, reason: `O logo precisa ser imagem: ${source.name}` };
    if (unsafeName(source.name)) return { ...vazio, reason: `Nome de arquivo inseguro: ${source.name}` };
    if (!(logo.to > logo.from)) return { ...vazio, reason: "A janela do logo precisa de duração positiva." };
    if (!inputIndex.has(logo.mediaId)) {
      inputIndex.set(logo.mediaId, totalInputs);
      totalInputs += 1;
      // `-loop 1` porque sem ele a imagem é um vídeo de UM quadro: o overlay a
      // mostraria por 1/25s e sumiria. Com o loop o stream é infinito e quem
      // liga/desliga é o `enable`; a renderização não trava porque o quadro-guia
      // do overlay é a base — quando ela acaba, o encode acaba.
      inputArgs.push("-loop", "1", "-i", source.name);
    }
  }

  const withAudio = options.withAudio ?? true;
  const duracoes = clips.map((clip) => clip.end - clip.start);
  // A transição do ÚLTIMO clipe não existe: não há próximo.
  const transicoes = clips.slice(0, -1).map((clip) => {
    if (!clip.transition || clip.transition === "none") return 0;
    const duracao = clip.transitionDuration ?? 0.5;
    return Math.max(0.05, duracao);
  });

  // Transição maior que o clipe consumiria o clipe inteiro e o ffmpeg falha.
  for (let i = 0; i < transicoes.length; i += 1) {
    const limite = Math.min(duracoes[i] ?? 0, duracoes[i + 1] ?? 0);
    if ((transicoes[i] ?? 0) >= limite) {
      return {
        ...vazio,
        reason: `A transição do clipe ${i + 1} (${transicoes[i]}s) é maior que o clipe — reduza para menos de ${limite.toFixed(2)}s.`
      };
    }
  }

  const filters: string[] = [];
  clips.forEach((clip, i) => {
    const index = inputIndex.get(clip.mediaId) ?? 0;
    filters.push(
      `[${index}:v]trim=start=${seconds(clip.start)}:end=${seconds(clip.end)},setpts=PTS-STARTPTS[v${i}]`
    );
    if (withAudio) {
      filters.push(
        `[${index}:a]atrim=start=${seconds(clip.start)}:end=${seconds(clip.end)},asetpts=PTS-STARTPTS[a${i}]`
      );
    }
  });

  // Vídeo: encadeia xfade quando há transição, senão concatena.
  let videoLabel: string;
  const temTransicao = transicoes.some((valor) => valor > 0);
  if (temTransicao && clips.length > 1) {
    const offsets = xfadeOffsets(duracoes, transicoes);
    let atual = "v0";
    for (let i = 1; i < clips.length; i += 1) {
      const anterior = clips[i - 1];
      const duracao = transicoes[i - 1] ?? 0;
      const saida = `x${i}`;
      if (duracao > 0 && anterior !== undefined) {
        const nome = XFADE_NAME[(anterior.transition ?? "fade") as Exclude<TransitionKind, "none">] ?? "fade";
        filters.push(
          `[${atual}][v${i}]xfade=transition=${nome}:duration=${seconds(duracao)}:offset=${seconds(offsets[i - 1] ?? 0)}[${saida}]`
        );
      } else {
        // Sem transição neste par: emenda seca, mas a cadeia continua.
        filters.push(`[${atual}][v${i}]concat=n=2:v=1:a=0[${saida}]`);
      }
      atual = saida;
    }
    videoLabel = atual;
    if (withAudio) {
      // O áudio não acompanha o xfade: ele é concatenado inteiro, então o som
      // fica mais longo que a imagem. Dizer isso é melhor que entregar um
      // arquivo dessincronizado sem aviso.
      warnings.push(
        "com transição, o áudio é concatenado sem sobreposição — pode ficar mais longo que a imagem"
      );
    }
  } else {
    const pads = clips.map((_, i) => `[v${i}]`).join("");
    filters.push(`${pads}concat=n=${clips.length}:v=1:a=0[vbase]`);
    videoLabel = "vbase";
  }

  // Logos: cada imagem entra como overlay sobre o resultado da cadeia.
  logos.forEach((logo, i) => {
    const index = inputIndex.get(logo.mediaId) ?? 0;
    const saida = `lg${i}`;
    filters.push(
      `[${videoLabel}][${index}:v]overlay=x=${Math.round(logo.x)}:y=${Math.round(logo.y)}:` +
        // `eof_action=pass` é redundante com o `-loop 1`, mas fica: se um dia a
        // entrada deixar de ser em loop, a base ainda segue em vez de congelar
        // no último quadro do logo.
        `eof_action=pass:enable='between(t,${seconds(logo.from)},${seconds(logo.to)})'[${saida}]`
    );
    videoLabel = saida;
  });

  // Textos sobre a imagem.
  const overlays = (options.texts ?? []).filter((overlay) => overlay.text.trim().length > 0);
  const fontFile = (options.fontFile ?? "").trim();
  // A ASPA DUPLA fecharia a citação do `-filter_complex` quando o comando for
  // exibido como texto: um caminho `C:/f"&&calc&&".ttf` sairia do filtro e
  // viraria comando. O `unsafeName` (usado em saída e mídia) já a recusa pelo
  // mesmo motivo; a aspas simples fecharia a seção `'…'` do próprio filtro.
  if (fontFile && /["'\r\n]/.test(fontFile)) {
    return { ...vazio, reason: "Caminho de fonte inválido." };
  }
  // `C:/…` precisa do MESMO cuidado do texto: os dois pontos da letra de
  // unidade separariam opções e o filtro não montaria. A barra invertida do
  // Windows vira `/`, que o ffmpeg aceita e dispensa mais um nível de escape.
  const fontArg = fontFile ? `fontfile='${fontFile.replace(/\\/g, "/").replace(/:/g, "\\:")}':` : "";
  overlays.forEach((overlay, i) => {
    const saida = `txt${i}`;
    filters.push(
      // `expansion=none` é obrigatório: no padrão (`normal`) o drawtext lê
      // `%{…}` como expressão e um `%` solto aborta a renderização inteira
      // ("Stray %"). Texto de usuário nunca deve virar expressão do ffmpeg.
      `[${videoLabel}]drawtext=${fontArg}expansion=none:text='${escapeDrawText(overlay.text)}':` +
        `x=${Math.round(overlay.x)}:y=${Math.round(overlay.y)}:` +
        `fontsize=${Math.max(8, Math.round(overlay.fontSize))}:fontcolor=${overlay.color}:` +
        `enable='between(t,${seconds(overlay.from)},${seconds(overlay.to)})'[${saida}]`
    );
    videoLabel = saida;
  });
  if (overlays.length && !fontFile) {
    // Sem fontconfig — o caso comum no Windows — o drawtext falha com
    // "Cannot find a valid font". Avisar antes vale mais que descobrir isso
    // depois de o agente esperar a renderização.
    warnings.push("informe o arquivo de fonte: no Windows o ffmpeg costuma não achar fonte sozinho");
  }

  const audioFilters: string[] = [];
  if (withAudio) {
    const pads = clips.map((_, i) => `[a${i}]`).join("");
    audioFilters.push(`${pads}concat=n=${clips.length}:v=0:a=1[aout]`);
  }

  // `-y` para o ffmpeg não PERGUNTAR se pode sobrescrever: no terminal do
  // agente não há quem responda e o processo ficaria pendurado. A sobrescrita
  // é anunciada no texto que vai ao composer — quem aprova sabe o que aprova.
  const args: string[] = [
    "-y",
    ...inputArgs,
    "-filter_complex",
    [...filters, ...audioFilters].join(";"),
    "-map",
    `[${videoLabel}]`
  ];
  if (withAudio) args.push("-map", "[aout]");
  args.push(output);

  return {
    ok: true,
    args,
    output,
    durationSec: composedDuration(duracoes, transicoes),
    warnings
  };
}

/**
 * Um argumento atravessa sem aspas quando só tem caracteres que nenhum shell
 * da casa (PowerShell, cmd, bash) interpreta. Colchetes ficam de fora de
 * propósito: `[vbase]` é padrão de glob no bash — sem aspas, um arquivo de
 * nome `v` no diretório mudaria o argumento em silêncio.
 */
const ARG_SIMPLES = /^[A-Za-z0-9._/:=,\-]+$/;

/**
 * Cita a lista de args para EXIBIÇÃO — é o texto que vai ao composer e que o
 * agente roda depois do portão de aprovação. Aspas duplas em volta de tudo
 * que não é trivial, com a aspa dupla interna escapada como `\"`. Os nomes
 * com aspas já foram RECUSADOS na montagem; o escape aqui cobre o texto de
 * drawtext (que aceita `"`), cinto além do suspensório. A citação é a mesma
 * do orquestrador (estilo cmd): é o formato que o terminal do agente espera.
 */
export function formatFfmpegArgs(args: readonly string[]): string {
  const partes = args.map((arg) =>
    ARG_SIMPLES.test(arg) ? arg : `"${arg.replace(/"/g, '\\"')}"`
  );
  return ["ffmpeg", ...partes].join(" ");
}
