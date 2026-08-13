import { describe, expect, it, vi } from "vitest";

import type { SecurityFinding } from "@ai-orchestrator/contracts";

import {
  buildInvestigationPrompt,
  buildRevalidationPrompt,
  clipAtLine,
  DEFAULT_MATCHERS,
  findCandidates,
  findingToGoal,
  fingerprint,
  planResume,
  parseVerdict,
  runDeepReview,
  type Matcher
} from "./securityReview";

const achado = (over: Partial<SecurityFinding> = {}): SecurityFinding => ({
  id: "f1",
  severity: "high",
  title: "SQL montado por concatenação",
  file: "api/users.ts",
  detail: "o id vem de req.query e entra na consulta sem parâmetro",
  ...over
});

/** Parser de mentira: devolve os achados que o teste combinou. */
const parseFixo = (lista: SecurityFinding[]) => () => lista;

describe("findCandidates", () => {
  it("marca o arquivo que executa processo e diz por quê", () => {
    const { candidates } = findCandidates([
      { path: "a.ts", content: "import { execSync } from 'child_process';" }
    ]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].reasons.join(" ")).toContain("executa processo");
  });

  it("ignora arquivo sem nenhuma superfície", () => {
    expect(findCandidates([{ path: "a.ts", content: "export const cor = 'azul';" }]).candidates).toEqual([]);
  });

  it("soma os pesos: quem toca auth E executa vem antes de quem só faz fetch", () => {
    const { candidates } = findCandidates([
      { path: "leve.ts", content: "await fetch('/x')" },
      { path: "pesado.ts", content: "if (isAdmin(user)) { execSync(cmd) }" }
    ]);
    expect(candidates[0].path).toBe("pesado.ts");
  });

  it("descarta gerado, minificado e dependência", () => {
    const { candidates } = findCandidates([
      { path: "node_modules/x/index.js", content: "eval(a)" },
      { path: "dist/app.min.js", content: "eval(a)" },
      { path: "src/app.ts", content: "eval(a)" }
    ]);
    expect(candidates.map((item) => item.path)).toEqual(["src/app.ts"]);
  });

  it("respeita o teto e DIZ quantos ficaram de fora", () => {
    const arquivos = Array.from({ length: 10 }, (_, index) => ({
      path: `f${index}.ts`,
      content: "req.query.id"
    }));
    const { candidates, skipped } = findCandidates(arquivos, { limit: 3 });
    expect(candidates).toHaveLength(3);
    // Sem esse número, a revisão pareceria ter coberto tudo.
    expect(skipped).toBe(7);
  });

  it("aceita matchers de fora — é o gancho dos plugins do admin", () => {
    const meu: Matcher[] = [
      { id: "multi", label: "usa o guard interno", pattern: /guardMultiplike/, weight: 9 }
    ];
    const { candidates } = findCandidates([{ path: "a.ts", content: "guardMultiplike(req)" }], {
      matchers: meu
    });
    expect(candidates[0].reasons).toEqual(["usa o guard interno"]);
  });

  it("nenhum matcher padrão é global — `lastIndex` vazaria entre arquivos", () => {
    // Regex global mantém `lastIndex` entre chamadas de `.test`, e o segundo
    // arquivo começaria a busca no meio.
    for (const matcher of DEFAULT_MATCHERS) expect(matcher.pattern.global).toBe(false);
  });

  it("o mesmo arquivo dá o mesmo resultado duas vezes seguidas", () => {
    const arquivos = [{ path: "a.ts", content: "req.body; eval(x);" }];
    expect(findCandidates(arquivos)).toEqual(findCandidates(arquivos));
  });
});

describe("clipAtLine", () => {
  it("não corta o que cabe", () => {
    expect(clipAtLine("abc", 10)).toEqual({ text: "abc", clipped: false });
  });

  it("corta no fim de uma linha, não no meio de uma função", () => {
    const texto = "linha1\nlinha2\nlinha3 muito muito longa";
    const { text, clipped } = clipAtLine(texto, 20);
    expect(clipped).toBe(true);
    expect(text.endsWith("\n")).toBe(false);
    expect(texto.startsWith(text)).toBe(true);
    expect(text.split("\n")).toEqual(["linha1", "linha2"]);
  });

  it("linha única gigante é cortada mesmo assim, em vez de estourar o limite", () => {
    const { text, clipped } = clipAtLine("x".repeat(100), 10);
    expect(clipped).toBe(true);
    expect(text).toHaveLength(10);
  });
});

describe("buildInvestigationPrompt", () => {
  it("manda UM arquivo e conta por que ele foi marcado", () => {
    const messages = buildInvestigationPrompt(
      { path: "api/users.ts", content: "req.query.id" },
      ["lê entrada do usuário"]
    );
    expect(messages[1].content).toContain("api/users.ts");
    expect(messages[1].content).toContain("lê entrada do usuário");
  });

  it("manda verificar a mitigação ANTES de apontar", () => {
    expect(buildInvestigationPrompt({ path: "a", content: "" }, [])[0].content).toContain("mitigação");
  });

  it("diz que array vazio é resposta válida — senão o modelo inventa achado", () => {
    expect(buildInvestigationPrompt({ path: "a", content: "" }, [])[0].content).toContain("vazio");
  });

  it("avisa quando o arquivo foi cortado", () => {
    const grande = { path: "a.ts", content: "linha\n".repeat(6000) };
    expect(buildInvestigationPrompt(grande, [])[1].content).toContain("cortado");
  });
});

describe("buildRevalidationPrompt", () => {
  it("pede para DERRUBAR, não para confirmar", () => {
    const system = buildRevalidationPrompt(achado(), { path: "a", content: "" })[0].content;
    expect(system).toContain("derrubar");
    expect(system).toContain("REFUTA");
  });

  it("manda refutar na dúvida", () => {
    expect(buildRevalidationPrompt(achado(), { path: "a", content: "" })[0].content).toContain("dúvida");
  });

  it("leva o achado e o arquivo para o refutador julgar", () => {
    const user = buildRevalidationPrompt(achado({ line: 42 }), {
      path: "api/users.ts",
      content: "const q = `select ${id}`"
    })[1].content;
    expect(user).toContain("SQL montado por concatenação");
    expect(user).toContain("42");
    expect(user).toContain("select");
  });
});

describe("parseVerdict", () => {
  it("lê a refutação", () => {
    expect(parseVerdict('{"confirmed":false,"reason":"a consulta é parametrizada"}')).toEqual({
      confirmed: false,
      severity: undefined,
      reason: "a consulta é parametrizada"
    });
  });

  it("lê a confirmação com severidade rebaixada", () => {
    const verdict = parseVerdict('{"confirmed":true,"severity":"low","reason":"só alcançável por admin"}');
    expect(verdict.confirmed).toBe(true);
    expect(verdict.severity).toBe("low");
  });

  it("tolera cerca de markdown e texto em volta", () => {
    expect(parseVerdict('Analisei:\n```json\n{"confirmed":false}\n```').confirmed).toBe(false);
  });

  it("resposta ilegível CONFIRMA — descartar por falha de parsing esconderia bug real", () => {
    for (const lixo of ["não entendi", "", "{quebrado"]) {
      const verdict = parseVerdict(lixo);
      expect(verdict.confirmed).toBe(true);
      expect(verdict.reason).toContain("formato");
    }
  });

  it("severidade inventada é descartada, mantendo a do achado", () => {
    expect(parseVerdict('{"confirmed":true,"severity":"apocalíptica"}').severity).toBeUndefined();
  });
});

describe("planResume", () => {
  const arquivos = [
    { path: "a.ts", content: "eval(x)" },
    { path: "b.ts", content: "eval(y)" }
  ];
  const candidatos = findCandidates(arquivos).candidates;

  it("sem progresso anterior, tudo é investigado", () => {
    const plano = planResume(candidatos, arquivos, {});
    expect(plano.pending).toHaveLength(2);
    expect(plano.reused).toEqual([]);
  });

  it("arquivo intacto é reaproveitado — investigação é o passo caro", () => {
    const plano = planResume(candidatos, arquivos, { "a.ts": fingerprint("eval(x)") });
    expect(plano.pending.map((item) => item.path)).toEqual(["b.ts"]);
    expect(plano.reused).toEqual(["a.ts"]);
  });

  it("arquivo ALTERADO volta para a fila, mesmo tendo sido investigado", () => {
    const alterados = [{ path: "a.ts", content: "eval(x); novaLinha();" }];
    const plano = planResume(findCandidates(alterados).candidates, alterados, {
      "a.ts": fingerprint("eval(x)")
    });
    expect(plano.pending).toHaveLength(1);
    expect(plano.reused).toEqual([]);
  });

  it("impressão muda com o conteúdo e é estável para o mesmo texto", () => {
    expect(fingerprint("abc")).toBe(fingerprint("abc"));
    expect(fingerprint("abc")).not.toBe(fingerprint("abd"));
  });
});

describe("findingToGoal", () => {
  it("vira um pedido que a equipe de agentes entende", () => {
    const texto = findingToGoal(achado({ line: 12, suggestion: "use consulta parametrizada" }));
    expect(texto).toContain("Corrigir a falha de segurança");
    expect(texto).toContain("api/users.ts:12");
    expect(texto).toContain("use consulta parametrizada");
  });

  it("manda confirmar antes de mexer — o achado pode ser falso positivo", () => {
    expect(findingToGoal(achado())).toContain("Confirme a falha");
  });

  it("achado sem linha e sem sugestão não deixa campo vazio no texto", () => {
    const texto = findingToGoal(achado());
    expect(texto).not.toContain("undefined");
    expect(texto).not.toContain("Sugestão");
  });
});

describe("runDeepReview", () => {
  const arquivos = [
    { path: "api/users.ts", content: "const q = `select * from u where id=${req.query.id}`" },
    { path: "ui/cor.ts", content: "export const cor = 'azul';" }
  ];

  function correr(over: Partial<Parameters<typeof runDeepReview>[0]> = {}) {
    return runDeepReview({
      files: arquivos,
      call: async () => "",
      parse: parseFixo([]),
      signal: new AbortController().signal,
      ...over
    });
  }

  it("investiga só os candidatos, não o projeto inteiro", async () => {
    const call = vi.fn(async () => "");
    await correr({ call });
    // `ui/cor.ts` não tem superfície: nem investigação, nem custo.
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("um arquivo por investigação — não N num prompt só", async () => {
    const enviados: string[] = [];
    await runDeepReview({
      files: [
        { path: "a.ts", content: "eval(x)" },
        { path: "b.ts", content: "eval(y)" }
      ],
      call: async (messages) => {
        enviados.push(messages[1].content);
        return "";
      },
      parse: parseFixo([]),
      signal: new AbortController().signal
    });
    expect(enviados).toHaveLength(2);
    expect(enviados[0]).not.toContain("b.ts");
    expect(enviados[1]).not.toContain("a.ts");
  });

  it("cada achado passa pela refutação", async () => {
    const call = vi.fn(async () => '{"confirmed":true,"reason":"explorável sem autenticação"}');
    const resultado = await correr({ call, parse: parseFixo([achado()]) });
    // Uma investigação + uma refutação.
    expect(call).toHaveBeenCalledTimes(2);
    expect(resultado.confirmed).toHaveLength(1);
    expect(resultado.confirmed[0].verdict.reason).toContain("explorável");
  });

  it("o refutado NÃO é apagado — fica separado com o motivo", async () => {
    const resultado = await correr({
      call: async () => '{"confirmed":false,"reason":"a consulta usa parâmetro ligado"}',
      parse: parseFixo([achado()])
    });
    expect(resultado.confirmed).toEqual([]);
    expect(resultado.refuted).toHaveLength(1);
    expect(resultado.refuted[0].verdict.reason).toContain("parâmetro ligado");
  });

  it("a refutação pode REBAIXAR a severidade do achado", async () => {
    const resultado = await correr({
      call: async () => '{"confirmed":true,"severity":"low","reason":"só admin alcança"}',
      parse: parseFixo([achado({ severity: "critical" })])
    });
    expect(resultado.confirmed[0].severity).toBe("low");
  });

  it("ordena os confirmados pela severidade", async () => {
    let volta = 0;
    const resultado = await runDeepReview({
      files: [{ path: "a.ts", content: "eval(x)" }],
      call: async () => {
        volta += 1;
        return volta === 1 ? "" : '{"confirmed":true}';
      },
      parse: parseFixo([achado({ severity: "low", title: "L" }), achado({ severity: "critical", title: "C" })]),
      signal: new AbortController().signal
    });
    expect(resultado.confirmed.map((item) => item.title)).toEqual(["C", "L"]);
  });

  it("informa quantos candidatos ficaram fora do teto", async () => {
    const muitos = Array.from({ length: 5 }, (_, index) => ({ path: `f${index}.ts`, content: "eval(x)" }));
    const resultado = await runDeepReview({
      files: muitos,
      call: async () => "",
      parse: parseFixo([]),
      signal: new AbortController().signal,
      limit: 2
    });
    expect(resultado.investigated).toBe(2);
    expect(resultado.skipped).toBe(3);
  });

  it("respeita o teto de investigações simultâneas", async () => {
    const muitos = Array.from({ length: 6 }, (_, index) => ({ path: `f${index}.ts`, content: "eval(x)" }));
    let emVoo = 0;
    let pico = 0;
    await runDeepReview({
      files: muitos,
      call: async () => {
        emVoo += 1;
        pico = Math.max(pico, emVoo);
        await new Promise((resolve) => setTimeout(resolve, 5));
        emVoo -= 1;
        return "";
      },
      parse: parseFixo([]),
      signal: new AbortController().signal,
      concurrency: 2
    });
    expect(pico).toBe(2);
  });

  it("cancelamento interrompe e é declarado", async () => {
    const controller = new AbortController();
    const muitos = Array.from({ length: 5 }, (_, index) => ({ path: `f${index}.ts`, content: "eval(x)" }));
    const resultado = await runDeepReview({
      files: muitos,
      call: async () => {
        controller.abort();
        return "";
      },
      parse: parseFixo([]),
      signal: controller.signal,
      concurrency: 1
    });
    expect(resultado.cancelled).toBe(true);
    expect(resultado.investigated).toBeLessThan(5);
  });

  it("retomada pula o que não mudou e devolve o progresso atualizado", async () => {
    const call = vi.fn(async () => "");
    const primeira = await correr({ call });
    expect(primeira.investigated).toBe(1);
    expect(primeira.reused).toBe(0);

    // Segunda volta com o progresso da primeira: nada mudou, nada reinvestiga.
    const segunda = await correr({ call, progress: primeira.progress });
    expect(segunda.investigated).toBe(0);
    expect(segunda.reused).toBe(1);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("erro na refutação NÃO carimba o arquivo como revisado", async () => {
    // Carimbar o arquivo e depois falhar escondia os achados restantes: a
    // volta seguinte dizia "nada mudou" e a falha nunca aparecia.
    let volta = 0;
    const resultado = await runDeepReview({
      files: arquivos,
      call: async () => {
        volta += 1;
        if (volta === 1) return "achado";
        throw new Error("rede caiu no meio da refutação");
      },
      parse: parseFixo([achado()]),
      signal: new AbortController().signal
    });
    expect(resultado.progress["api/users.ts"]).toBeUndefined();
    expect(resultado.confirmed).toEqual([]);
  });

  it("cancelamento no meio das refutações não carimba o arquivo", async () => {
    const controller = new AbortController();
    let volta = 0;
    const resultado = await runDeepReview({
      files: arquivos,
      call: async () => {
        volta += 1;
        // 1: investigação · 2: refutação do 1º achado (e cancela) · o 2º
        // achado não chega a ser julgado.
        if (volta === 2) controller.abort();
        return volta === 1 ? "achado" : '{"confirmed":true}';
      },
      parse: parseFixo([achado(), { ...achado(), title: "segundo" }]),
      signal: controller.signal
    });
    expect(resultado.progress["api/users.ts"]).toBeUndefined();
    expect(resultado.cancelled).toBe(true);
  });

  it("arquivo julgado até o fim é carimbado e não repete na volta seguinte", async () => {
    const call = vi.fn(async () => '{"confirmed":true}');
    const primeira = await correr({ call, parse: parseFixo([achado()]) });
    expect(primeira.progress["api/users.ts"]).toBeTruthy();

    const segunda = await correr({
      call,
      parse: parseFixo([achado()]),
      progress: primeira.progress
    });
    expect(segunda.investigated).toBe(0);
    expect(segunda.reused).toBe(1);
  });

  it("avisa o progresso por arquivo e por refutação", async () => {
    const notas: string[] = [];
    await correr({
      call: async () => '{"confirmed":true}',
      parse: parseFixo([achado()]),
      hooks: { onStage: (texto) => notas.push(texto) }
    });
    expect(notas.some((nota) => nota.includes("investigando api/users.ts"))).toBe(true);
    expect(notas.some((nota) => nota.startsWith("refutando"))).toBe(true);
  });
});
