/**
 * Composição de vídeo — multi-track, transições e texto sobre a imagem.
 *
 * Substitui o antigo `videoExport`, que só concatenava trechos. Aqui está o
 * que faltava para o editor deixar de ser só um cortador:
 *
 * - **transições** entre clipes (`xfade`), com a aritmética de offset feita
 *   certo — é onde quase toda implementação erra;
 * - **segunda faixa** sobreposta (`overlay`), para logo, PiP ou selo;
 * - **texto** sobre a imagem (`drawtext`), com janela de tempo.
 *
 * Continua puro: monta o comando, não executa. Quem roda é o terminal, com o
 * `cwd` na pasta da mídia — os nomes resolvem como caminho relativo e não
 * precisamos de diálogo de arquivo nem de caminho absoluto.
 *
 * Coberto por videoCompose.test.ts.
 */

export type TransitionKind = "none" | "fade" | "wipeleft" | "wiperight" | "slideup" | "dissolve";

/** Nome do filtro `xfade` para cada transição oferecida na UI. */
const XFADE_NAME: Record<Exclude<TransitionKind, "none">, string> = {
  fade: "fade",
  wipeleft: "wipeleft",
  wiperight: "wiperight",
  slideup: "slideup",
  dissolve: "dissolve"
};

export interface ComposeClip {
  mediaId: string;
  start: number;
  end: number;
  /**
   * Faixa. 0 é a base; 1 ou mais sobrepõem. Clipe de faixa alta vira
   * `overlay` sobre a base, posicionado por `x`/`y`.
   */
  track?: number;
  /** Transição PARA O PRÓXIMO clipe da mesma faixa base. */
  transition?: TransitionKind;
  /** Duração da transição, em segundos. */
  transitionDuration?: number;
  /** Posição do overlay, quando `track` > 0. */
  x?: number;
  y?: number;
  /** Momento na linha do tempo final em que o overlay aparece. */
  overlayAt?: number;
}

export interface ComposeMedia {
  id: string;
  name: string;
}

export interface TextOverlay {
  text: string;
  x: number;
  y: number;
  fontSize: number;
  /** Cor no formato que o ffmpeg entende (`white`, `#ffffff`). */
  color: string;
  /** Janela em que o texto aparece, em segundos do vídeo final. */
  from: number;
  to: number;
}

export interface ComposeOptions {
  output?: string;
  withAudio?: boolean;
  overlays?: TextOverlay[];
  /**
   * Fonte para o `drawtext`.
   *
   * No Windows o ffmpeg quase nunca vem com fontconfig, então `font=Arial`
   * falha e só o caminho do arquivo (`C:/Windows/Fonts/arial.ttf`) funciona.
   */
  fontFile?: string;
}

export interface ComposePlan {
  ok: boolean;
  command: string;
  reason?: string;
  output: string;
  /** Duração final estimada — encurta a cada transição. */
  durationSec: number;
  /** Avisos que não impedem a exportação, mas o usuário precisa ler. */
  warnings: string[];
}

/** Aspas ou quebra de linha no nome escapariam do comando. */
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
    acumulado += durations[i];
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
  const sobreposto = transitions.slice(0, Math.max(0, durations.length - 1)).reduce((soma, valor) => soma + valor, 0);
  return Math.max(0, total - sobreposto);
}

/**
 * Monta o comando de composição.
 *
 * Recusa em vez de gerar comando frágil — um ffmpeg que falha no meio da
 * exportação custa mais tempo que uma recusa clara na hora de montar.
 */
export function buildCompose(
  clips: ComposeClip[],
  media: ComposeMedia[],
  options: ComposeOptions = {}
): ComposePlan {
  const output = (options.output ?? "composicao.mp4").trim() || "composicao.mp4";
  const vazio: ComposePlan = { ok: false, command: "", output, durationSec: 0, warnings: [] };
  if (unsafeName(output)) return { ...vazio, reason: "Nome de saída inválido." };

  const base = clips.filter((clip) => (clip.track ?? 0) === 0);
  const sobrepostos = clips.filter((clip) => (clip.track ?? 0) > 0);
  if (!base.length) return { ...vazio, reason: "A faixa principal está vazia — adicione ao menos um clipe." };

  const byId = new Map(media.map((item) => [item.id, item]));
  const warnings: string[] = [];

  // Um `-i` por mídia usada, em ordem estável.
  const inputs: string[] = [];
  const inputIndex = new Map<string, number>();
  for (const clip of [...base, ...sobrepostos]) {
    const source = byId.get(clip.mediaId);
    if (!source) return { ...vazio, reason: "Um clipe aponta para mídia que não está mais importada." };
    if (!(clip.end > clip.start)) return { ...vazio, reason: "Todo clipe precisa de duração positiva." };
    if (unsafeName(source.name)) return { ...vazio, reason: `Nome de arquivo inseguro: ${source.name}` };
    if (!inputIndex.has(clip.mediaId)) {
      inputIndex.set(clip.mediaId, inputs.length);
      inputs.push(source.name);
    }
  }

  const withAudio = options.withAudio ?? true;
  const duracoes = base.map((clip) => clip.end - clip.start);
  // A transição do ÚLTIMO clipe não existe: não há próximo.
  const transicoes = base.slice(0, -1).map((clip) => {
    if (!clip.transition || clip.transition === "none") return 0;
    const duracao = clip.transitionDuration ?? 0.5;
    return Math.max(0.05, duracao);
  });

  // Transição maior que o clipe consumiria o clipe inteiro e o ffmpeg falha.
  for (let i = 0; i < transicoes.length; i += 1) {
    const limite = Math.min(duracoes[i], duracoes[i + 1]);
    if (transicoes[i] >= limite) {
      return {
        ...vazio,
        reason: `A transição do clipe ${i + 1} (${transicoes[i]}s) é maior que o clipe — reduza para menos de ${limite.toFixed(2)}s.`
      };
    }
  }

  const filters: string[] = [];
  base.forEach((clip, i) => {
    const index = inputIndex.get(clip.mediaId)!;
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
  if (temTransicao && base.length > 1) {
    const offsets = xfadeOffsets(duracoes, transicoes);
    let atual = "v0";
    for (let i = 1; i < base.length; i += 1) {
      const anterior = base[i - 1];
      const duracao = transicoes[i - 1];
      const saida = `x${i}`;
      if (duracao > 0) {
        const nome = XFADE_NAME[(anterior.transition ?? "fade") as Exclude<TransitionKind, "none">] ?? "fade";
        filters.push(
          `[${atual}][v${i}]xfade=transition=${nome}:duration=${seconds(duracao)}:offset=${seconds(offsets[i - 1])}[${saida}]`
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
    const pads = base.map((_, i) => `[v${i}]`).join("");
    filters.push(`${pads}concat=n=${base.length}:v=1:a=0[vbase]`);
    videoLabel = "vbase";
  }

  // Faixas sobrepostas: cada uma entra como overlay sobre o resultado.
  sobrepostos.forEach((clip, i) => {
    const index = inputIndex.get(clip.mediaId)!;
    const rotulo = `ov${i}`;
    const inicio = Math.max(0, clip.overlayAt ?? 0);
    // `setpts=PTS-STARTPTS` zera o relógio do trecho: sem somar o início, o
    // overlay tocaria desde o segundo 0 e o `enable` só o esconderia — o
    // usuário veria o meio do clipe aparecer no lugar do começo.
    const desloca = inicio > 0 ? `+${seconds(inicio)}/TB` : "";
    filters.push(
      `[${index}:v]trim=start=${seconds(clip.start)}:end=${seconds(clip.end)},` +
        `setpts=PTS-STARTPTS${desloca}[${rotulo}]`
    );
    const fim = inicio + (clip.end - clip.start);
    const saida = `ovout${i}`;
    filters.push(
      `[${videoLabel}][${rotulo}]overlay=x=${Math.round(clip.x ?? 0)}:y=${Math.round(clip.y ?? 0)}:` +
        // `eof_action=pass` deixa a base seguir depois que o overlay acaba;
        // o padrão (`repeat`) congelaria o último quadro dele.
        `eof_action=pass:enable='between(t,${seconds(inicio)},${seconds(fim)})'[${saida}]`
    );
    videoLabel = saida;
  });

  // Textos sobre a imagem.
  const overlays = (options.overlays ?? []).filter((overlay) => overlay.text.trim().length > 0);
  const fontFile = (options.fontFile ?? "").trim();
  // A ASPA DUPLA fecha o `-filter_complex "…"` no nível do cmd.exe: um caminho
  // `C:/f"&&calc&&".ttf` sairia do filtro e viraria comando. O `unsafeName`
  // (usado em saída e mídia) já a recusa pelo mesmo motivo; aqui ela passava.
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
    // depois de esperar a exportação.
    warnings.push("informe o arquivo de fonte: no Windows o ffmpeg costuma não achar fonte sozinho");
  }

  const audioFilters: string[] = [];
  let mapAudio = "";
  if (withAudio) {
    const pads = base.map((_, i) => `[a${i}]`).join("");
    audioFilters.push(`${pads}concat=n=${base.length}:v=0:a=1[aout]`);
    mapAudio = ` -map "[aout]"`;
  }

  const inputArgs = inputs.map((name) => `-i "${name}"`).join(" ");
  const todos = [...filters, ...audioFilters].join(";");
  const command = `ffmpeg -y ${inputArgs} -filter_complex "${todos}" -map "[${videoLabel}]"${mapAudio} "${output}"`;

  return {
    ok: true,
    command,
    output,
    durationSec: composedDuration(duracoes, transicoes),
    warnings
  };
}
