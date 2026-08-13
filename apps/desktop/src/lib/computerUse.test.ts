import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));

const {
  COMPUTER_TOOLS,
  COMPUTER_TOOL_NAMES,
  computerUseInstruction,
  dispatchComputerTool
} = await import("./computerUse");

const SESSAO = "sessao-1";

beforeEach(() => invokeMock.mockReset());

describe("superfície das ferramentas", () => {
  it("expõe as quatro ferramentas da área isolada", () => {
    expect([...COMPUTER_TOOL_NAMES].sort()).toEqual([
      "computer_exec",
      "computer_list",
      "computer_read",
      "computer_write"
    ]);
  });

  /** Só a execução é mutante — escrever num diretório efêmero não é. */
  it("apenas computer_exec é marcada como mutante", () => {
    const mutantes = COMPUTER_TOOLS.filter((spec) => spec.mutating).map((spec) => spec.name);
    expect(mutantes).toEqual(["computer_exec"]);
  });
});

describe("sem sessão aberta", () => {
  it("nenhuma ferramenta executa e a mensagem é honesta", async () => {
    for (const tool of COMPUTER_TOOL_NAMES) {
      const result = await dispatchComputerTool(tool, { path: "x", command: "dir" }, "");
      expect(result.ok).toBe(false);
      expect(result.output).toContain("área de trabalho isolada");
    }
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe("computer_write", () => {
  it("manda sessão e caminho relativo — nunca um caminho absoluto", async () => {
    invokeMock.mockResolvedValue("gravado: script.py (10 bytes)");
    const result = await dispatchComputerTool(
      "computer_write",
      { path: "script.py", content: "print(1)" },
      SESSAO
    );
    expect(result.ok).toBe(true);
    const [comando, payload] = invokeMock.mock.calls[0];
    expect(comando).toBe("sandbox_write");
    expect(payload).toEqual({ session: SESSAO, path: "script.py", content: "print(1)" });
  });

  it("exige o caminho", async () => {
    const result = await dispatchComputerTool("computer_write", { content: "x" }, SESSAO);
    expect(result.ok).toBe(false);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  /**
   * A recusa de `..` é do Rust (workspace.rs) — aqui o que importa é que o
   * erro volte como TEXTO para o modelo, e não derrube a execução.
   */
  it("recusa do Rust vira resultado de ferramenta, não exceção", async () => {
    // `...Once` e não uma implementação persistente: a persistente fica valendo
    // depois que este teste termina e o vitest acaba reportando a rejeição como
    // não tratada, mesmo com o código sob teste capturando a dele.
    invokeMock.mockRejectedValueOnce(new Error("caminho não pode subir de diretório (..)"));
    const result = await dispatchComputerTool("computer_write", { path: "../fuga", content: "x" }, SESSAO);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("subir de diretório");
  });
});

describe("computer_exec", () => {
  it("passa a sessão e NUNCA um cwd", async () => {
    invokeMock.mockResolvedValue({ exitCode: 0, stdout: "ok", stderr: "", durationMs: 12, jailed: true });
    const result = await dispatchComputerTool("computer_exec", { command: "python script.py" }, SESSAO);
    expect(result.ok).toBe(true);
    const [comando, payload] = invokeMock.mock.calls[0];
    expect(comando).toBe("sandbox_execute");
    expect(payload).toMatchObject({ command: "python script.py", session: SESSAO, cwd: null });
  });

  it("código diferente de zero não é sucesso", async () => {
    invokeMock.mockResolvedValue({ exitCode: 1, stdout: "", stderr: "boom", durationMs: 5, jailed: true });
    const result = await dispatchComputerTool("computer_exec", { command: "falha" }, SESSAO);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("stderr");
    expect(result.output).toContain("boom");
  });

  /** Se o Job Object não valeu, o modelo e o log precisam saber. */
  it("avisa quando rodou sem Job Object", async () => {
    invokeMock.mockResolvedValue({ exitCode: 0, stdout: "x", stderr: "", durationMs: 1, jailed: false });
    const result = await dispatchComputerTool("computer_exec", { command: "dir" }, SESSAO);
    expect(result.output).toContain("SEM Job Object");
  });

  it("comando vazio é recusado sem chamar o backend", async () => {
    const result = await dispatchComputerTool("computer_exec", { command: "  " }, SESSAO);
    expect(result.ok).toBe(false);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("sem saída nenhuma o resultado ainda é legível", async () => {
    invokeMock.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "", durationMs: 3, jailed: true });
    const result = await dispatchComputerTool("computer_exec", { command: "rem" }, SESSAO);
    expect(result.output).toContain("(sem saída)");
  });
});

describe("computer_list", () => {
  it("formata pastas e arquivos", async () => {
    invokeMock.mockResolvedValue([
      { name: "src", isDir: true, size: 0 },
      { name: "a.txt", isDir: false, size: 12 }
    ]);
    const result = await dispatchComputerTool("computer_list", {}, SESSAO);
    expect(result.output).toBe("src/\na.txt (12 B)");
  });

  it("pasta vazia diz que está vazia", async () => {
    invokeMock.mockResolvedValue([]);
    expect((await dispatchComputerTool("computer_list", {}, SESSAO)).output).toBe("(vazio)");
  });

  it("sub vazio vira null em vez de string vazia", async () => {
    invokeMock.mockResolvedValue([]);
    await dispatchComputerTool("computer_list", { sub: "   " }, SESSAO);
    expect(invokeMock.mock.calls[0][1]).toEqual({ session: SESSAO, sub: null });
  });
});

describe("ferramenta desconhecida", () => {
  it("não chama o backend", async () => {
    const result = await dispatchComputerTool("computer_format_disk", {}, SESSAO);
    expect(result.ok).toBe(false);
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe("instrução ao modelo", () => {
  it("lista as ferramentas e as regras da área", () => {
    const texto = computerUseInstruction();
    for (const spec of COMPUTER_TOOLS) expect(texto).toContain(spec.name);
    expect(texto).toContain("SEMPRE relativos à sessão");
    expect(texto).toContain("PERSISTEM entre chamadas");
    expect(texto).toContain("apagada ao fim da execução");
  });

  /** Sem isto o modelo tenta caminho absoluto e gasta voltas até desistir. */
  it("diz explicitamente que caminho absoluto é recusado", () => {
    expect(computerUseInstruction()).toContain("Caminho absoluto e `..` são recusados");
  });

  it("avisa que exec pede aprovação a cada chamada", () => {
    expect(computerUseInstruction()).toContain("aprovação de uma pessoa a CADA chamada");
  });
});
