import { describe, expect, it, vi } from "vitest";

import {
  CodeModeError,
  codeModeInstruction,
  parseProgram,
  runProgram,
  tokenize,
  type Json,
  type RunOptions
} from "./codeMode";

/** Execução com ferramentas de mentira — o teste não toca em nada real. */
function run(source: string, over: Partial<RunOptions> = {}) {
  const call = over.call ?? (async (tool: string, args: Record<string, Json>) => ({ tool, args } as Json));
  return runProgram(source, { call, allowed: over.allowed ?? ["ler", "gravar", "listar"], ...over });
}

describe("tokenize", () => {
  it("separa nome, número, texto e pontuação", () => {
    const tokens = tokenize('const a = 1 + "x"');
    expect(tokens.map((token) => token.kind)).toEqual(["name", "name", "punct", "num", "punct", "str", "eof"]);
  });

  it("ignora comentário de linha", () => {
    expect(tokenize("// nota\nconst a = 1").filter((token) => token.kind !== "eof")).toHaveLength(4);
  });

  it("entende escape dentro do texto", () => {
    expect(tokenize('"linha\\numa"')[0].value).toBe("linha\numa");
  });

  it("texto sem fechar é recusado", () => {
    expect(() => tokenize('"sem fim')).toThrow(CodeModeError);
  });

  it("caractere fora do subconjunto é recusado", () => {
    expect(() => tokenize("a @ b")).toThrow(/não suportado/);
  });
});

describe("parseProgram", () => {
  it("aceita o formato que o modelo escreve", () => {
    const ast = parseProgram(`
      const arquivos = tool.listar({ pasta: "src" });
      for (const f of arquivos.itens) {
        log f.nome;
      }
      return { total: arquivos.itens.length };
    `);
    expect(ast.map((stmt) => stmt.type)).toEqual(["let", "for", "return"]);
  });

  it("aceita e ignora `await`, que o modelo escreve por hábito", () => {
    const ast = parseProgram("const a = await tool.ler({ x: 1 });");
    expect(ast[0]).toMatchObject({ type: "let", value: { type: "call", tool: "ler" } });
  });

  it("aceita `else if` encadeado", () => {
    const ast = parseProgram('if (1 > 2) { log "a"; } else if (2 > 1) { log "b"; } else { log "c"; }');
    expect(ast[0].type).toBe("if");
  });
});

describe("o subconjunto fecha as saídas", () => {
  it("recusa chamada que não seja de ferramenta", () => {
    // É o que impede `algumObjeto.metodo()` de virar um caminho novo.
    expect(() => parseProgram("const a = algo.metodo();")).toThrow(/só `tool\.nome/);
  });

  it("recusa acesso por índice calculado", () => {
    expect(() => parseProgram("const a = lista[i];")).toThrow(/índice/);
  });

  it("não existe `while`", async () => {
    const resultado = await run("while (true) { log 1; }");
    expect(resultado.ok).toBe(false);
  });

  it("variável não declarada não resolve para nada do host", async () => {
    for (const nome of ["window", "globalThis", "process", "fetch", "document"]) {
      const resultado = await run(`return ${nome};`);
      expect(resultado.ok).toBe(false);
      expect(resultado.reason).toContain("não foi declarado");
    }
  });

  it("não dá para escalar por __proto__ nem constructor", async () => {
    const chave = await run('return { __proto__: "x" };');
    expect(chave.ok).toBe(false);
    expect(chave.reason).toContain("__proto__");

    // Ler o campo devolve nulo em vez de expor a cadeia de protótipos.
    const leitura = await run('const a = { b: 1 }; return a.constructor;');
    expect(leitura).toMatchObject({ ok: true, value: null });
  });

  it("reatribuição não existe", async () => {
    const resultado = await run("const a = 1; const a = 2;");
    expect(resultado.ok).toBe(false);
    expect(resultado.reason).toContain("já foi declarado");
  });
});

describe("execução", () => {
  it("devolve o valor do return", async () => {
    expect(await run('return "pronto";')).toMatchObject({ ok: true, value: "pronto" });
  });

  it("chama a ferramenta com os argumentos avaliados", async () => {
    const call = vi.fn(async () => ({ ok: true } as Json));
    const resultado = await run('const n = 2; tool.gravar({ caminho: "a" + n, vezes: n * 3 });', { call });
    expect(call).toHaveBeenCalledWith("gravar", { caminho: "a2", vezes: 6 });
    expect(resultado.calls).toHaveLength(1);
  });

  it("passa o resultado da ferramenta para a expressão seguinte", async () => {
    const call = async () => ({ itens: [{ nome: "a" }, { nome: "b" }] } as Json);
    const resultado = await run("const r = tool.listar({}); return r.itens.length;", { call });
    expect(resultado.value).toBe(2);
  });

  it("percorre a lista devolvida pela ferramenta", async () => {
    const call = async () => ({ itens: [{ nome: "a" }, { nome: "b" }] } as Json);
    const resultado = await run("const r = tool.listar({}); for (const i of r.itens) { log i.nome; }", { call });
    expect(resultado.logs).toEqual(["a", "b"]);
  });

  it("combina vários passos num programa só — é o ponto do modo", async () => {
    const call = vi.fn(async (tool: string) =>
      tool === "listar" ? ({ itens: [{ nome: "a" }, { nome: "b" }] } as Json) : ({ ok: true } as Json)
    );
    const resultado = await run(
      `const r = tool.listar({ pasta: "src" });
       for (const f of r.itens) { tool.gravar({ caminho: f.nome }); }
       return { gravados: r.itens.length };`,
      { call }
    );
    // Uma ida ao modelo, três chamadas de ferramenta.
    expect(call).toHaveBeenCalledTimes(3);
    expect(resultado.value).toEqual({ gravados: 2 });
  });

  it("if/else escolhe o ramo certo", async () => {
    expect((await run('if (2 > 1) { return "sim"; } else { return "não"; }')).value).toBe("sim");
    expect((await run('if (1 > 2) { return "sim"; } else { return "não"; }')).value).toBe("não");
  });

  it("curto-circuito não avalia o lado direito", async () => {
    const call = vi.fn(async () => null as Json);
    await run("const a = false && tool.gravar({});", { call });
    expect(call).not.toHaveBeenCalled();
  });

  it("campo ausente devolve nulo em vez de estourar", async () => {
    expect((await run("const a = { b: 1 }; return a.zzz;")).value).toBeNull();
  });

  it("escopo do laço não vaza para fora", async () => {
    const resultado = await run("for (const i of [1, 2]) { log i; } return i;");
    expect(resultado.ok).toBe(false);
    expect(resultado.reason).toContain("não foi declarado");
  });
});

describe("tetos e recusas", () => {
  it("ferramenta fora da lista é recusada, dizendo qual", async () => {
    const resultado = await run("tool.apagarTudo({});", { allowed: ["ler"] });
    expect(resultado.ok).toBe(false);
    expect(resultado.reason).toContain("apagarTudo");
  });

  it("teto de chamadas segura o custo", async () => {
    const resultado = await run("for (const i of [1,2,3,4,5]) { tool.ler({}); }", {
      limits: { maxCalls: 3 }
    });
    expect(resultado.ok).toBe(false);
    expect(resultado.reason).toContain("3 chamadas");
    // As três que couberam aconteceram de verdade: o teto para, não desfaz.
    expect(resultado.calls).toHaveLength(3);
  });

  it("lista maior que o teto do laço é recusada antes de rodar", async () => {
    const call = vi.fn(async () => null as Json);
    const resultado = await run("for (const i of [1,2,3]) { tool.ler({}); }", {
      limits: { maxLoop: 2 },
      call
    });
    expect(resultado.ok).toBe(false);
    expect(call).not.toHaveBeenCalled();
  });

  it("teto de passos impede programa que gira sem sair do lugar", async () => {
    const resultado = await run("const a = 1 + 1 + 1 + 1 + 1;", { limits: { maxSteps: 3 } });
    expect(resultado.ok).toBe(false);
    expect(resultado.reason).toContain("passos");
  });

  it("texto que dobra é barrado antes de esgotar a memória", async () => {
    // Os tetos contavam ocorrências, nunca TAMANHO: vinte dobras a partir de
    // 1 KB passavam folgado nos 2.000 passos e derrubavam o renderer — sem
    // chamar ferramenta, ou seja, sem passar por aprovação nenhuma.
    const programa = [
      'const s0 = "aaaaaaaaaa";',
      ...Array.from({ length: 20 }, (_, i) => `const s${i + 1} = s${i} + s${i};`)
    ].join("\n");
    const resultado = await run(programa);
    expect(resultado.ok).toBe(false);
    expect(resultado.reason).toContain("caracteres");
  });

  it("interpolação de template falha alto em vez de virar texto literal", async () => {
    const resultado = await run("const soma = 2; log(`total: ${soma}`);");
    expect(resultado.ok).toBe(false);
    expect(resultado.reason).toContain("interpolação");
  });

  it("programa cortado no meio devolve erro de sintaxe, não TypeError", async () => {
    for (const truncado of ["const", "let x", "for (const"]) {
      const resultado = await run(truncado);
      expect(resultado.ok).toBe(false);
      expect(resultado.reason).not.toContain("undefined");
    }
  });

  it("cancelamento interrompe no meio", async () => {
    const controller = new AbortController();
    const call = async () => {
      controller.abort();
      return null as Json;
    };
    const resultado = await run("tool.ler({}); tool.ler({}); tool.ler({});", { call, signal: controller.signal });
    expect(resultado.ok).toBe(false);
    expect(resultado.reason).toContain("cancelada");
    expect(resultado.calls).toHaveLength(1);
  });

  it("programa que não compila devolve o motivo, não exceção", async () => {
    const resultado = await run("const = ;");
    expect(resultado.ok).toBe(false);
    expect(resultado.reason).toBeTruthy();
    expect(resultado.calls).toEqual([]);
  });

  it("divisão por zero é recusada — Infinity não é JSON", async () => {
    expect((await run("return 1 / 0;")).ok).toBe(false);
  });

  it("percorrer o que não é lista é recusado", async () => {
    expect((await run('for (const i of "abc") { log i; }')).ok).toBe(false);
  });

  it("argumento que não é objeto é recusado", async () => {
    const resultado = await run('tool.ler("caminho");');
    expect(resultado.ok).toBe(false);
    expect(resultado.reason).toContain("objeto de argumentos");
  });

  it("erro da ferramenta vira falha do programa, com o motivo", async () => {
    const call = async () => {
      throw new Error("sem permissão");
    };
    const resultado = await run("tool.gravar({});", { call });
    expect(resultado.ok).toBe(false);
    expect(resultado.reason).toContain("sem permissão");
  });
});

describe("codeModeInstruction", () => {
  it("lista as ferramentas liberadas e os tetos", () => {
    const texto = codeModeInstruction(["ler", "gravar"], { maxSteps: 10, maxCalls: 5, maxLoop: 20 });
    expect(texto).toContain("ler, gravar");
    expect(texto).toContain("5 chamadas");
    expect(texto).toContain("20 itens");
  });

  it("diz que o gate de aprovação continua valendo", () => {
    expect(codeModeInstruction(["ler"])).toContain("aprovação");
  });

  it("declara o que NÃO existe, para o modelo não tentar", () => {
    const texto = codeModeInstruction([]);
    expect(texto).toContain("while");
    expect(texto).toContain("rede");
    expect(texto).toContain("nenhuma");
  });
});
