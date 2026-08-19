/**
 * A montagem do comando ffmpeg como lista de args.
 *
 * Os casos do escape e da aritmética do xfade são os MESMOS do orquestrador
 * (lib/videoCompose.test.ts) — o comportamento foi verificado lá renderizando
 * quadro, e o porte só vale se preservar exatamente essas respostas. Os casos
 * novos fixam o contrato desta casa: args como lista (nunca string de shell),
 * logo de imagem com `-loop 1` e a citação de exibição do formatFfmpegArgs.
 */

import { describe, expect, it } from "vitest";

import {
  buildFfmpegArgs,
  composedDuration,
  escapeDrawText,
  formatFfmpegArgs,
  xfadeOffsets
} from "./ffmpegArgs";
import type { TextOverlay, VideoClip, VideoMedia } from "./timeline";

const media: VideoMedia[] = [
  { id: "m1", name: "abertura.mp4", kind: "video", duration: 30 },
  { id: "m2", name: "corpo.mp4", kind: "video", duration: 30 },
  { id: "m3", name: "final.mp4", kind: "video", duration: 30 },
  { id: "img", name: "logo.png", kind: "image", duration: 0 }
];

const clip = (over: Partial<VideoClip> = {}): VideoClip => ({
  id: "c1",
  mediaId: "m1",
  name: "abertura",
  start: 0,
  end: 10,
  ...over
});

const texto = (over: Partial<TextOverlay> = {}): TextOverlay => ({
  id: "t1",
  text: "Oi",
  x: 0,
  y: 0,
  fontSize: 20,
  color: "white",
  from: 0,
  to: 2,
  ...over
});

/** O filtro é UM argumento — o que segue o -filter_complex. */
function filtro(args: string[]): string {
  const index = args.indexOf("-filter_complex");
  expect(index).toBeGreaterThan(-1);
  return args[index + 1] ?? "";
}

describe("escapeDrawText", () => {
  it("escapa os dois pontos que separam opções do filtro", () => {
    expect(escapeDrawText("Reunião: 10h")).toBe("Reunião\\: 10h");
  });

  it("troca o apóstrofo reto pelo tipográfico, que o parser não lê", () => {
    // Verificado no orquestrador renderizando um quadro: nem `\'` nem `'\''`
    // funcionam dentro do valor — a aspas fecha a seção e `:x=…:fontsize=…`
    // vaza para dentro da legenda. Sem apóstrofo reto, não há o que vazar.
    expect(escapeDrawText("d'água")).toBe("d’água");
  });

  it("não deixa nenhuma aspas simples chegar ao comando", () => {
    expect(escapeDrawText("a'b'c")).not.toContain("'");
  });

  it("apóstrofo E dois-pontos juntos — o caso real de legenda", () => {
    expect(escapeDrawText("Cena d'água: take 2")).toBe("Cena d’água\\: take 2");
  });

  it("escapa a barra invertida antes de tudo, sem duplicar o escape seguinte", () => {
    expect(escapeDrawText("a\\b:c")).toBe("a\\\\b\\:c");
  });

  it("escapa o porcento, que o drawtext expandiria", () => {
    expect(escapeDrawText("100% pronto")).toBe("100\\% pronto");
  });

  it("achata quebras de linha em espaço", () => {
    expect(escapeDrawText("linha1\nlinha2")).toBe("linha1 linha2");
  });
});

describe("xfadeOffsets", () => {
  it("posiciona a primeira transição no fim do primeiro clipe menos a duração", () => {
    expect(xfadeOffsets([10, 10], [2])).toEqual([8]);
  });

  it("desconta as transições anteriores no offset seguinte", () => {
    // Sem descontar, a segunda cairia em 20-2=18. Mas o vídeo já encurtou 2s
    // na primeira transição, então o ponto certo é 16.
    expect(xfadeOffsets([10, 10, 10], [2, 2])).toEqual([8, 16]);
  });

  it("acumula o desconto ao longo de vários clipes", () => {
    expect(xfadeOffsets([5, 5, 5, 5], [1, 1, 1])).toEqual([4, 8, 12]);
  });

  it("trata transição zero como emenda seca sem encurtar nada", () => {
    expect(xfadeOffsets([10, 10, 10], [0, 2])).toEqual([10, 18]);
  });

  it("não devolve offset negativo quando a transição é maior que o clipe", () => {
    expect(xfadeOffsets([1, 10], [5])).toEqual([0]);
  });

  it("não gera transição para um único clipe", () => {
    expect(xfadeOffsets([10], [])).toEqual([]);
  });
});

describe("composedDuration", () => {
  it("soma os clipes quando não há transição", () => {
    expect(composedDuration([10, 5], [0])).toBe(15);
  });

  it("encurta o total por cada sobreposição", () => {
    expect(composedDuration([10, 10, 10], [2, 3])).toBe(25);
  });

  it("ignora transição sobrando além do número de emendas", () => {
    expect(composedDuration([10], [4])).toBe(10);
  });
});

describe("buildFfmpegArgs", () => {
  it("devolve LISTA de args — nunca string de shell, nenhum arg pré-citado", () => {
    const plan = buildFfmpegArgs([clip()], media, { withAudio: false });
    expect(plan.ok).toBe(true);
    expect(Array.isArray(plan.args)).toBe(true);
    // Os nomes entram crus: a citação é de quem exibe, não de quem monta.
    expect(plan.args).toContain("abertura.mp4");
    expect(plan.args.some((arg) => arg.includes('"'))).toBe(false);
  });

  it("concatena a trilha quando não há transição", () => {
    const plan = buildFfmpegArgs([clip(), clip({ id: "c2", mediaId: "m2", end: 5 })], media, {
      withAudio: false
    });
    expect(filtro(plan.args)).toContain("[v0][v1]concat=n=2:v=1:a=0[vbase]");
    const mapIndex = plan.args.indexOf("-map");
    expect(plan.args[mapIndex + 1]).toBe("[vbase]");
    expect(plan.durationSec).toBe(15);
  });

  it("encadeia xfade usando o offset acumulado", () => {
    const plan = buildFfmpegArgs(
      [
        clip({ transition: "fade", transitionDuration: 2 }),
        clip({ id: "c2", mediaId: "m2", transition: "wipeleft", transitionDuration: 2 }),
        clip({ id: "c3", mediaId: "m3" })
      ],
      media,
      { withAudio: false }
    );
    const graph = filtro(plan.args);
    expect(graph).toContain("[v0][v1]xfade=transition=fade:duration=2:offset=8[x1]");
    expect(graph).toContain("[x1][v2]xfade=transition=wipeleft:duration=2:offset=16[x2]");
    expect(plan.durationSec).toBe(26);
  });

  it("usa a transição do clipe de origem, não a do destino", () => {
    const plan = buildFfmpegArgs(
      [
        clip({ transition: "slideup", transitionDuration: 1 }),
        clip({ id: "c2", mediaId: "m2", transition: "dissolve" })
      ],
      media,
      { withAudio: false }
    );
    // A transição pendurada no último clipe não tem próximo: só a do primeiro vale.
    expect(filtro(plan.args)).toContain("xfade=transition=slideup");
    expect(filtro(plan.args)).not.toContain("dissolve");
  });

  it("recusa transição maior que o MENOR dos dois clipes vizinhos", () => {
    const plan = buildFfmpegArgs(
      [clip({ end: 10, transition: "fade", transitionDuration: 3 }), clip({ id: "c2", mediaId: "m2", end: 2 })],
      media
    );
    expect(plan.ok).toBe(false);
    expect(plan.reason).toContain("maior que o clipe");
    expect(plan.reason).toContain("2.00s");
  });

  it("declara cada mídia uma única vez, mesmo reusada em vários clipes", () => {
    const plan = buildFfmpegArgs(
      [clip(), clip({ id: "c2", start: 20, end: 30 }), clip({ id: "c3", mediaId: "m2" })],
      media,
      { withAudio: false }
    );
    expect(plan.args.filter((arg) => arg === "-i")).toHaveLength(2);
    expect(filtro(plan.args)).toContain("[0:v]trim=start=20:end=30");
  });

  it("logo de imagem entra com -loop 1 e liga/desliga pela janela do enable", () => {
    const plan = buildFfmpegArgs([clip()], media, {
      withAudio: false,
      logos: [{ id: "l1", mediaId: "img", x: 24, y: 36, from: 1, to: 4 }]
    });
    expect(plan.ok).toBe(true);
    // O `-loop 1` precisa vir imediatamente antes do `-i logo.png`.
    const loopIndex = plan.args.indexOf("-loop");
    expect(plan.args.slice(loopIndex, loopIndex + 4)).toEqual(["-loop", "1", "-i", "logo.png"]);
    const graph = filtro(plan.args);
    expect(graph).toContain("[vbase][1:v]overlay=x=24:y=36:eof_action=pass:enable='between(t,1,4)'[lg0]");
    const mapIndex = plan.args.indexOf("-map");
    expect(plan.args[mapIndex + 1]).toBe("[lg0]");
  });

  it("recusa logo que aponta para vídeo — overlay de imagem é imagem", () => {
    const plan = buildFfmpegArgs([clip()], media, {
      logos: [{ id: "l1", mediaId: "m2", x: 0, y: 0, from: 0, to: 2 }]
    });
    expect(plan.ok).toBe(false);
    expect(plan.reason).toContain("imagem");
  });

  it("drawtext com apóstrofo e dois-pontos sai ESCAPADO e com expansion=none", () => {
    const plan = buildFfmpegArgs([clip()], media, {
      withAudio: false,
      texts: [texto({ text: "Cena d'água: take 2" })]
    });
    const graph = filtro(plan.args);
    expect(graph).toContain("drawtext=expansion=none:text='Cena d’água\\: take 2'");
    // Nenhum apóstrofo reto sobra dentro do valor do text.
    expect(graph).not.toContain("d'água");
  });

  it("desenha o texto sobre o último rótulo da cadeia e mapeia a saída dele", () => {
    const plan = buildFfmpegArgs([clip()], media, {
      withAudio: false,
      logos: [{ id: "l1", mediaId: "img", x: 0, y: 0, from: 0, to: 2 }],
      texts: [texto({ text: "Confidencial", x: 40, y: 50, fontSize: 32, from: 0, to: 5 })]
    });
    const graph = filtro(plan.args);
    expect(graph).toContain("[lg0]drawtext=expansion=none:text='Confidencial'");
    expect(graph).toContain("fontsize=32:fontcolor=white");
    expect(graph).toContain("enable='between(t,0,5)'");
    const mapIndex = plan.args.indexOf("-map");
    expect(plan.args[mapIndex + 1]).toBe("[txt0]");
  });

  it("escapa os dois pontos do caminho da fonte, que separariam opções", () => {
    const plan = buildFfmpegArgs([clip()], media, {
      withAudio: false,
      fontFile: "C:\\Windows\\Fonts\\arial.ttf",
      texts: [texto()]
    });
    expect(filtro(plan.args)).toContain("drawtext=fontfile='C\\:/Windows/Fonts/arial.ttf':expansion=none:text='Oi'");
    expect(plan.warnings.join(" ")).not.toContain("arquivo de fonte");
  });

  it("avisa sobre a fonte quando há texto e nenhuma fonte", () => {
    const plan = buildFfmpegArgs([clip()], media, { withAudio: false, texts: [texto()] });
    expect(plan.warnings.join(" ")).toContain("arquivo de fonte");
  });

  it("não gera drawtext para texto em branco", () => {
    const plan = buildFfmpegArgs([clip()], media, { withAudio: false, texts: [texto({ text: "   " })] });
    expect(filtro(plan.args)).not.toContain("drawtext");
    expect(plan.warnings).toEqual([]);
  });

  it("mantém o tamanho de fonte num piso legível", () => {
    const plan = buildFfmpegArgs([clip()], media, { withAudio: false, texts: [texto({ fontSize: 1 })] });
    expect(filtro(plan.args)).toContain("fontsize=8");
  });

  it("com áudio, concatena as faixas e avisa que a transição não o acompanha", () => {
    const plan = buildFfmpegArgs(
      [clip({ transition: "fade", transitionDuration: 1 }), clip({ id: "c2", mediaId: "m2" })],
      media,
      { withAudio: true }
    );
    expect(plan.warnings.join(" ")).toContain("áudio é concatenado");
    expect(filtro(plan.args)).toContain("[a0][a1]concat=n=2:v=0:a=1[aout]");
    expect(plan.args).toContain("[aout]");
  });

  it("sem áudio não há atrim nem aviso", () => {
    const plan = buildFfmpegArgs(
      [clip({ transition: "fade", transitionDuration: 1 }), clip({ id: "c2", mediaId: "m2" })],
      media,
      { withAudio: false }
    );
    expect(plan.warnings).toEqual([]);
    expect(filtro(plan.args)).not.toContain("atrim");
  });

  it("recusa timeline vazia", () => {
    const plan = buildFfmpegArgs([], media);
    expect(plan.ok).toBe(false);
    expect(plan.reason).toContain("vazia");
  });

  it("recusa clipe sem duração", () => {
    const plan = buildFfmpegArgs([clip({ start: 5, end: 5 })], media);
    expect(plan.ok).toBe(false);
    expect(plan.reason).toContain("duração positiva");
  });

  it("recusa clipe apontando para mídia removida", () => {
    const plan = buildFfmpegArgs([clip({ mediaId: "sumiu" })], media);
    expect(plan.ok).toBe(false);
    expect(plan.reason).toContain("mídia");
  });

  it("recusa nome de arquivo com aspas, que escaparia da citação de exibição", () => {
    const plan = buildFfmpegArgs([clip({ mediaId: "mx" })], [
      { id: "mx", name: 'a".mp4', kind: "video", duration: 10 }
    ]);
    expect(plan.ok).toBe(false);
    expect(plan.reason).toContain("inseguro");
  });

  it("recusa nome de saída com aspas", () => {
    const plan = buildFfmpegArgs([clip()], media, { output: 'x" & calc.mp4' });
    expect(plan.ok).toBe(false);
    expect(plan.reason).toContain("saída inválido");
  });

  it("recusa caminho de fonte com aspas simples", () => {
    const plan = buildFfmpegArgs([clip()], media, { fontFile: "a'.ttf", texts: [texto()] });
    expect(plan.ok).toBe(false);
    expect(plan.reason).toContain("fonte");
  });

  it("cai no nome padrão quando a saída vem vazia", () => {
    const plan = buildFfmpegArgs([clip()], media, { output: "   " });
    expect(plan.output).toBe("corte-final.mp4");
    expect(plan.ok).toBe(true);
  });

  it("um único clipe sem nada em volta sai completo, com -y e a saída no fim", () => {
    const plan = buildFfmpegArgs([clip({ start: 2, end: 7 })], media, { withAudio: false });
    expect(plan.args).toEqual([
      "-y",
      "-i",
      "abertura.mp4",
      "-filter_complex",
      "[0:v]trim=start=2:end=7,setpts=PTS-STARTPTS[v0];[v0]concat=n=1:v=1:a=0[vbase]",
      "-map",
      "[vbase]",
      "corte-final.mp4"
    ]);
  });
});

describe("formatFfmpegArgs", () => {
  it("cita só o que precisa: nome simples passa cru, filtro e espaço ganham aspas", () => {
    const linha = formatFfmpegArgs(["-y", "-i", "abertura.mp4", "-i", "meu corte.mp4", "-filter_complex", "a;b'c"]);
    expect(linha).toBe('ffmpeg -y -i abertura.mp4 -i "meu corte.mp4" -filter_complex "a;b\'c"');
  });

  it("escapa aspas duplas internas — o texto do drawtext pode carregá-las", () => {
    expect(formatFfmpegArgs(['text="x"'])).toBe('ffmpeg "text=\\"x\\""');
  });

  it("o plano real vira uma linha executável com o filtro e o rótulo do -map citados", () => {
    const plan = buildFfmpegArgs([clip()], media, { withAudio: false });
    const linha = formatFfmpegArgs(plan.args);
    expect(linha.startsWith("ffmpeg -y -i abertura.mp4 -filter_complex \"")).toBe(true);
    // `[vbase]` sem aspas seria glob no bash: um arquivo chamado `v` no
    // diretório trocaria o argumento em silêncio.
    expect(linha).toContain('-map "[vbase]"');
    expect(linha.endsWith(" corte-final.mp4")).toBe(true);
  });
});
