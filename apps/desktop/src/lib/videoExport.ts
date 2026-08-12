/**
 * Export de vídeo — monta o comando ffmpeg do corte final.
 *
 * O editor antes só COPIAVA o comando; nunca rodava. E tinha três defeitos que
 * a auditoria pegou: usava só o nome do arquivo (sem caminho), assumia que
 * todo clipe tem faixa de áudio (quebrava em vídeo mudo), e não tinha como
 * executar. Aqui o comando é puro e testável; quem chama roda via terminal
 * com o `cwd` apontando para a PASTA da mídia — assim os nomes resolvem como
 * caminho relativo, sem precisar de caminho absoluto nem de plugin de diálogo.
 */

export interface ExportClip {
  mediaId: string;
  /** Entrada/saída em segundos dentro da mídia de origem. */
  start: number;
  end: number;
}

export interface ExportMedia {
  id: string;
  /** Nome do arquivo NA PASTA de mídia (o cwd do ffmpeg). */
  name: string;
}

export interface ExportOptions {
  /** Nome do arquivo de saída — gravado na mesma pasta. */
  output?: string;
  /** Concatenar também o áudio. Desligue para clipes mudos (senão o ffmpeg
   *  falha ao mapear uma faixa de áudio inexistente). */
  withAudio?: boolean;
}

export interface ExportPlan {
  ok: boolean;
  /** Comando ffmpeg pronto, ou vazio quando `ok` é false. */
  command: string;
  /** Motivo, quando não dá para exportar. */
  reason?: string;
  output: string;
}

/** Aspas duplas ou quebra de linha no nome fariam o comando escapar do escopo. */
function unsafeName(name: string): boolean {
  return /["\r\n]/.test(name) || name.trim().length === 0;
}

/**
 * Monta o comando. Não executa. Recusa em vez de gerar um comando frágil:
 * sem clipes, clipe com duração não positiva ou nome de arquivo perigoso.
 */
export function buildFfmpegExport(
  clips: ExportClip[],
  media: ExportMedia[],
  options: ExportOptions = {}
): ExportPlan {
  const output = (options.output ?? "corte-final.mp4").trim() || "corte-final.mp4";
  if (unsafeName(output)) return { ok: false, command: "", reason: "Nome de saída inválido.", output };
  if (!clips.length) return { ok: false, command: "", reason: "Adicione ao menos um clipe à timeline.", output };

  const withAudio = options.withAudio ?? true;
  const byId = new Map(media.map((item) => [item.id, item]));

  // Ordem estável de inputs, um -i por mídia usada.
  const inputs: string[] = [];
  const inputIndex = new Map<string, number>();
  for (const clip of clips) {
    const source = byId.get(clip.mediaId);
    if (!source) return { ok: false, command: "", reason: "Um clipe aponta para mídia que não está mais importada.", output };
    if (!(clip.end > clip.start)) return { ok: false, command: "", reason: "Todo clipe precisa de duração positiva.", output };
    if (unsafeName(source.name)) return { ok: false, command: "", reason: `Nome de arquivo inseguro: ${source.name}`, output };
    if (!inputIndex.has(clip.mediaId)) {
      inputIndex.set(clip.mediaId, inputs.length);
      inputs.push(source.name);
    }
  }

  const filters: string[] = [];
  clips.forEach((clip, i) => {
    const index = inputIndex.get(clip.mediaId)!;
    const start = clip.start.toFixed(2);
    const end = clip.end.toFixed(2);
    filters.push(`[${index}:v]trim=start=${start}:end=${end},setpts=PTS-STARTPTS[v${i}]`);
    if (withAudio) {
      filters.push(`[${index}:a]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS[a${i}]`);
    }
  });

  const pads = clips.map((_, i) => (withAudio ? `[v${i}][a${i}]` : `[v${i}]`)).join("");
  const concat = withAudio
    ? `${pads}concat=n=${clips.length}:v=1:a=1[vout][aout]`
    : `${pads}concat=n=${clips.length}:v=1:a=0[vout]`;
  const maps = withAudio ? `-map "[vout]" -map "[aout]"` : `-map "[vout]"`;

  const inputArgs = inputs.map((name) => `-i "${name}"`).join(" ");
  const command = `ffmpeg -y ${inputArgs} -filter_complex "${[...filters, concat].join(";")}" ${maps} "${output}"`;

  return { ok: true, command, output };
}
