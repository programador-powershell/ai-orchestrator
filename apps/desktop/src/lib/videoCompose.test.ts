import { describe, expect, it } from "vitest";

import {
  buildCompose,
  composedDuration,
  escapeDrawText,
  xfadeOffsets,
  type ComposeClip,
  type ComposeMedia
} from "./videoCompose";

const media: ComposeMedia[] = [
  { id: "m1", name: "abertura.mp4" },
  { id: "m2", name: "corpo.mp4" },
  { id: "m3", name: "logo.mp4" }
];

const clip = (over: Partial<ComposeClip> = {}): ComposeClip => ({
  mediaId: "m1",
  start: 0,
  end: 10,
  ...over
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
    // Um clipe só não tem emenda: a transição pendurada nele não conta.
    expect(composedDuration([10], [4])).toBe(10);
  });
});

describe("escapeDrawText", () => {
  it("escapa os dois pontos que separam opções do filtro", () => {
    expect(escapeDrawText("Reunião: 10h")).toBe("Reunião\\: 10h");
  });

  it("escapa aspas simples que fechariam o valor", () => {
    expect(escapeDrawText("d'água")).toBe("d\\'água");
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

describe("buildCompose", () => {
  it("concatena a faixa base quando não há transição", () => {
    const plan = buildCompose([clip(), clip({ mediaId: "m2", end: 5 })], media, { withAudio: false });
    expect(plan.ok).toBe(true);
    expect(plan.command).toContain("[v0][v1]concat=n=2:v=1:a=0[vbase]");
    expect(plan.command).toContain('-map "[vbase]"');
    expect(plan.durationSec).toBe(15);
  });

  it("encadeia xfade usando o offset acumulado", () => {
    const plan = buildCompose(
      [
        clip({ transition: "fade", transitionDuration: 2 }),
        clip({ mediaId: "m2", transition: "wipeleft", transitionDuration: 2 }),
        clip({ mediaId: "m3" })
      ],
      media,
      { withAudio: false }
    );
    expect(plan.command).toContain("[v0][v1]xfade=transition=fade:duration=2:offset=8[x1]");
    expect(plan.command).toContain("[x1][v2]xfade=transition=wipeleft:duration=2:offset=16[x2]");
    expect(plan.durationSec).toBe(26);
  });

  it("usa a transição do clipe de origem, não a do destino", () => {
    const plan = buildCompose(
      [clip({ transition: "slideup", transitionDuration: 1 }), clip({ mediaId: "m2", transition: "dissolve" })],
      media,
      { withAudio: false }
    );
    // A transição pendurada no último clipe não tem próximo: só a do primeiro vale.
    expect(plan.command).toContain("xfade=transition=slideup");
    expect(plan.command).not.toContain("dissolve");
  });

  it("recusa transição maior que o clipe em vez de gerar comando que falha", () => {
    const plan = buildCompose(
      [clip({ end: 3, transition: "fade", transitionDuration: 4 }), clip({ mediaId: "m2" })],
      media
    );
    expect(plan.ok).toBe(false);
    expect(plan.reason).toContain("maior que o clipe");
    expect(plan.reason).toContain("3.00s");
  });

  it("limita a transição pelo MENOR dos dois clipes vizinhos", () => {
    const plan = buildCompose(
      [clip({ end: 10, transition: "fade", transitionDuration: 3 }), clip({ mediaId: "m2", end: 2 })],
      media
    );
    expect(plan.ok).toBe(false);
    expect(plan.reason).toContain("2.00s");
  });

  it("sobrepõe a faixa 1 com overlay sobre o resultado da base", () => {
    const plan = buildCompose(
      [clip(), clip({ mediaId: "m3", track: 1, end: 4, x: 20, y: 30, overlayAt: 6 })],
      media,
      { withAudio: false }
    );
    expect(plan.command).toContain("[vbase][ov0]overlay=x=20:y=30:eof_action=pass");
    expect(plan.command).toContain("enable='between(t,6,10)'");
    expect(plan.command).toContain('-map "[ovout0]"');
  });

  it("desloca o PTS do overlay para ele começar de fato no tempo pedido", () => {
    const plan = buildCompose([clip(), clip({ mediaId: "m3", track: 1, end: 4, overlayAt: 6 })], media, {
      withAudio: false
    });
    // Sem o `+6/TB` o overlay tocaria desde o segundo 0 e o `enable` só o
    // esconderia — apareceria o meio do clipe no lugar do começo.
    expect(plan.command).toContain("setpts=PTS-STARTPTS+6/TB[ov0]");
  });

  it("não desloca o overlay que já começa em zero", () => {
    const plan = buildCompose([clip(), clip({ mediaId: "m3", track: 1, end: 4 })], media, { withAudio: false });
    expect(plan.command).toContain("setpts=PTS-STARTPTS[ov0]");
  });

  it("empilha overlays de várias faixas em cadeia", () => {
    const plan = buildCompose(
      [clip(), clip({ mediaId: "m2", track: 1, end: 3 }), clip({ mediaId: "m3", track: 2, end: 3 })],
      media,
      { withAudio: false }
    );
    expect(plan.command).toContain("[vbase][ov0]overlay");
    expect(plan.command).toContain("[ovout0][ov1]overlay");
    expect(plan.command).toContain('-map "[ovout1]"');
  });

  it("desenha o texto sobre o último rótulo da cadeia", () => {
    const plan = buildCompose([clip(), clip({ mediaId: "m2", track: 1, end: 3 })], media, {
      withAudio: false,
      overlays: [{ text: "Confidencial", x: 40, y: 50, fontSize: 32, color: "white", from: 0, to: 5 }]
    });
    expect(plan.command).toContain("[ovout0]drawtext=text='Confidencial'");
    expect(plan.command).toContain("fontsize=32:fontcolor=white");
    expect(plan.command).toContain("enable='between(t,0,5)'");
    expect(plan.command).toContain('-map "[txt0]"');
  });

  it("inclui o arquivo de fonte quando informado e some com o aviso", () => {
    const plan = buildCompose([clip()], media, {
      withAudio: false,
      fontFile: "C:\\Windows\\Fonts\\arial.ttf",
      overlays: [{ text: "Oi", x: 0, y: 0, fontSize: 20, color: "white", from: 0, to: 2 }]
    });
    expect(plan.command).toContain("drawtext=fontfile='C:/Windows/Fonts/arial.ttf':text='Oi'");
    expect(plan.warnings.join(" ")).not.toContain("arquivo de fonte");
  });

  it("avisa sobre a fonte quando há texto e nenhuma fonte", () => {
    const plan = buildCompose([clip()], media, {
      withAudio: false,
      overlays: [{ text: "Oi", x: 0, y: 0, fontSize: 20, color: "white", from: 0, to: 2 }]
    });
    expect(plan.warnings.join(" ")).toContain("arquivo de fonte");
  });

  it("não gera drawtext para texto em branco", () => {
    const plan = buildCompose([clip()], media, {
      withAudio: false,
      overlays: [{ text: "   ", x: 0, y: 0, fontSize: 20, color: "white", from: 0, to: 2 }]
    });
    expect(plan.command).not.toContain("drawtext");
    expect(plan.warnings).toEqual([]);
  });

  it("mantém o tamanho de fonte num piso legível", () => {
    const plan = buildCompose([clip()], media, {
      withAudio: false,
      overlays: [{ text: "Oi", x: 0, y: 0, fontSize: 1, color: "white", from: 0, to: 2 }]
    });
    expect(plan.command).toContain("fontsize=8");
  });

  it("avisa que o áudio não acompanha a transição", () => {
    const plan = buildCompose(
      [clip({ transition: "fade", transitionDuration: 1 }), clip({ mediaId: "m2" })],
      media,
      { withAudio: true }
    );
    expect(plan.warnings.join(" ")).toContain("áudio é concatenado");
    expect(plan.command).toContain('-map "[aout]"');
  });

  it("não avisa sobre áudio quando a exportação é muda", () => {
    const plan = buildCompose(
      [clip({ transition: "fade", transitionDuration: 1 }), clip({ mediaId: "m2" })],
      media,
      { withAudio: false }
    );
    expect(plan.warnings).toEqual([]);
    expect(plan.command).not.toContain("atrim");
  });

  it("declara cada mídia uma única vez, mesmo reusada em vários clipes", () => {
    const plan = buildCompose([clip(), clip({ start: 20, end: 30 }), clip({ mediaId: "m2" })], media, {
      withAudio: false
    });
    expect(plan.command.match(/-i "/g)).toHaveLength(2);
    expect(plan.command).toContain("[0:v]trim=start=20:end=30");
  });

  it("recusa quando a faixa base está vazia", () => {
    const plan = buildCompose([clip({ track: 1 })], media);
    expect(plan.ok).toBe(false);
    expect(plan.reason).toContain("faixa principal");
  });

  it("recusa clipe sem duração", () => {
    const plan = buildCompose([clip({ start: 5, end: 5 })], media);
    expect(plan.ok).toBe(false);
    expect(plan.reason).toContain("duração positiva");
  });

  it("recusa clipe apontando para mídia removida", () => {
    const plan = buildCompose([clip({ mediaId: "sumiu" })], media);
    expect(plan.ok).toBe(false);
    expect(plan.reason).toContain("mídia");
  });

  it("recusa nome de arquivo com aspas, que escaparia do comando", () => {
    const plan = buildCompose([clip({ mediaId: "mx" })], [{ id: "mx", name: 'a".mp4' }]);
    expect(plan.ok).toBe(false);
    expect(plan.reason).toContain("inseguro");
  });

  it("recusa nome de saída com aspas", () => {
    const plan = buildCompose([clip()], media, { output: 'x" & calc.mp4' });
    expect(plan.ok).toBe(false);
    expect(plan.reason).toContain("saída inválido");
  });

  it("recusa caminho de fonte com aspas simples", () => {
    const plan = buildCompose([clip()], media, {
      fontFile: "a'.ttf",
      overlays: [{ text: "Oi", x: 0, y: 0, fontSize: 20, color: "white", from: 0, to: 2 }]
    });
    expect(plan.ok).toBe(false);
    expect(plan.reason).toContain("fonte");
  });

  it("cai no nome padrão quando a saída vem vazia", () => {
    const plan = buildCompose([clip()], media, { output: "   " });
    expect(plan.output).toBe("composicao.mp4");
    expect(plan.ok).toBe(true);
  });

  it("exporta um único clipe sem transição nem overlay", () => {
    const plan = buildCompose([clip({ start: 2, end: 7 })], media, { withAudio: false });
    expect(plan.ok).toBe(true);
    expect(plan.command).toBe(
      'ffmpeg -y -i "abertura.mp4" -filter_complex ' +
        '"[0:v]trim=start=2:end=7,setpts=PTS-STARTPTS[v0];[v0]concat=n=1:v=1:a=0[vbase]" ' +
        '-map "[vbase]" "composicao.mp4"'
    );
  });
});
