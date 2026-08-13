import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DelegationLimits, TreeState } from "./agentTree";

/**
 * O modelo é a única dependência externa do runtime — mockado por um roteiro
 * de respostas. Assim dá para provar o comportamento que importa: o agente
 * DECIDE dividir, os subordinados rodam com contexto próprio e os relatórios
 * voltam para a síntese.
 */
// agent.ts importa fsx.ts, que lê `window` já na carga do módulo. Em ambiente
// node isso estoura antes de qualquer teste rodar.
vi.stubGlobal("window", {});

const chatOnceMock = vi.fn();
const dispatchToolMock = vi.fn();

/**
 * O runtime empilha no MESMO array de mensagens depois de chamar o modelo, e o
 * mock guardaria só a referência — a asserção leria o estado final, não o que
 * foi enviado naquela chamada. Por isso cada envio é copiado na hora.
 */
const enviadas: Array<Array<{ role: string; content: string }>> = [];
function capturar(args: unknown[]) {
  const messages = args[2] as Array<{ role: string; content: string }>;
  enviadas.push(messages.map((m) => ({ ...m })));
}

vi.mock("./engine", () => ({
  chatOnce: (...args: unknown[]) => {
    capturar(args);
    return chatOnceMock(...args);
  }
}));
vi.mock("./agent", async () => {
  const real = await vi.importActual<typeof import("./agent")>("./agent");
  return { ...real, dispatchTool: (...args: unknown[]) => dispatchToolMock(...args) };
});

const { runAgentGoal } = await import("./agentRuntime");

const LIMITS: DelegationLimits = { maxDepth: 2, maxChildren: 3, maxTotal: 8 };

/** Bloco de ferramenta no protocolo textual do app. */
const toolBlock = (tool: string, args: Record<string, unknown>) =>
  "```tool\n" + JSON.stringify({ tool, args }) + "\n```";

const delegar = (title: string, task: string) => toolBlock("delegate", { title, task });

/** Responde na ordem do roteiro; o resto devolve texto final. */
function roteiro(respostas: string[]) {
  let i = 0;
  chatOnceMock.mockImplementation(async () => respostas[i++] ?? "resposta final");
}

function correr(goal: string, limits = LIMITS, signal = new AbortController().signal) {
  const vistas: TreeState[] = [];
  return runAgentGoal({
    goal,
    selection: { kind: "workspace" },
    ctx: { session: null, runtimeRunning: false, fusionPresets: [] } as never,
    limits,
    root: "",
    signal,
    hooks: {
      onTree: (state) => vistas.push(state),
      approve: async () => true
    }
  }).then((final) => ({ final, vistas }));
}

beforeEach(() => {
  chatOnceMock.mockReset();
  dispatchToolMock.mockReset();
  enviadas.length = 0;
});

describe("acionamento simples", () => {
  it("sem delegação, a raiz responde sozinha", async () => {
    roteiro(["Consegui: o total é 42."]);
    const { final } = await correr("some 40 e 2");
    expect(final.spawned).toBe(1);
    expect(final.tasks[final.rootId].status).toBe("done");
    expect(final.tasks[final.rootId].report).toContain("42");
  });
});

describe("delegação", () => {
  it("o agente decide dividir e os subordinados rodam de verdade", async () => {
    roteiro([
      // raiz decide dividir em dois
      delegar("Vendas", "Levante as vendas do trimestre por região e devolva uma tabela.") +
        "\n" +
        delegar("Custos", "Levante os custos do trimestre por centro e devolva uma tabela."),
      // os dois subordinados respondem
      "Vendas: Sul 100, Norte 80.",
      "Custos: Sul 60, Norte 50.",
      // raiz sintetiza
      "Margem: Sul 40, Norte 30."
    ]);

    const { final } = await correr("montar o relatório trimestral");

    expect(final.spawned).toBe(3);
    const raiz = final.tasks[final.rootId];
    expect(raiz.childIds).toHaveLength(2);
    expect(raiz.status).toBe("done");
    expect(raiz.report).toContain("Margem");

    const filhos = raiz.childIds.map((id) => final.tasks[id]);
    expect(filhos.map((f) => f.title)).toEqual(["Vendas", "Custos"]);
    expect(filhos.every((f) => f.status === "done")).toBe(true);
    expect(filhos[0].depth).toBe(1);
  });

  /**
   * O ponto do acionamento: cada subordinado tem contexto PRÓPRIO. Ele recebe
   * a tarefa e a linhagem (para não sair do trilho), mas NÃO a conversa do
   * superior — é isso que mantém cada contexto pequeno em vez de acumular.
   */
  it("o subordinado recebe a tarefa, não a conversa do superior", async () => {
    roteiro([
      "Vou dividir isto." +
        delegar("Parte", "Faça a parte independente descrita aqui, com detalhes suficientes."),
      "parte pronta",
      "tudo certo"
    ]);
    await correr("objetivo do superior");

    // 2ª chamada = subordinado
    const mensagensSub = enviadas[1];
    const texto = mensagensSub.map((m) => m.content).join("\n");
    expect(texto).toContain("Faça a parte independente");
    // O raciocínio do superior NÃO viaja junto. (O prompt de sistema cita o
    // protocolo ```tool``` porque ENSINA a usá-lo — isso é esperado; o que
    // não pode aparecer é a chamada que o superior emitiu.)
    expect(texto).not.toContain("Vou dividir isto");
    expect(texto).not.toContain('"tool":"delegate"');
    expect(mensagensSub.filter((m) => m.role === "assistant")).toHaveLength(0);
    // Só a tarefa + o prompt de sistema: contexto curto por construção.
    expect(mensagensSub).toHaveLength(2);
  });

  it("os relatórios dos filhos voltam para o superior sintetizar", async () => {
    roteiro([
      delegar("A", "Uma subtarefa suficientemente descrita para rodar."),
      "achado do filho A",
      "sintetizado"
    ]);
    await correr("objetivo");

    // 3ª chamada = raiz de novo, já com o relatório
    const mensagensRaiz = enviadas[2];
    const ultima = mensagensRaiz[mensagensRaiz.length - 1].content;
    expect(ultima).toContain("achado do filho A");
    expect(ultima).toContain("Sintetize o resultado final");
  });

  it("subordinado que falha não derruba o irmão nem o superior", async () => {
    let chamada = 0;
    chatOnceMock.mockImplementation(async () => {
      chamada += 1;
      if (chamada === 1) {
        return (
          delegar("Bom", "Uma subtarefa que vai dar certo, descrita por completo.") +
          "\n" +
          delegar("Ruim", "Uma subtarefa que vai falhar, descrita por completo.")
        );
      }
      if (chamada === 2) return "resultado bom";
      if (chamada === 3) throw new Error("provedor indisponível");
      return "segui com o que deu";
    });

    const { final } = await correr("objetivo");
    const raiz = final.tasks[final.rootId];
    expect(raiz.status).toBe("done");
    const estados = raiz.childIds.map((id) => final.tasks[id].status);
    expect(estados).toContain("done");
    expect(estados).toContain("failed");
  });
});

describe("tetos", () => {
  /** O teto que impede recursão dirigida por modelo de virar gasto. */
  it("recusa acima da profundidade e diz o motivo ao modelo", async () => {
    const raso: DelegationLimits = { maxDepth: 0, maxChildren: 3, maxTotal: 8 };
    roteiro([delegar("X", "Uma subtarefa descrita com detalhes suficientes."), "fiz eu mesmo"]);

    const { final } = await correr("objetivo", raso);
    expect(final.spawned).toBe(1); // nenhum filho criado

    const segunda = enviadas[1];
    const feedback = segunda[segunda.length - 1].content;
    expect(feedback).toContain("profundidade máxima");
    expect(feedback).toContain("execute a tarefa diretamente");
  });

  it("recusa acima do número de filhos, mas aceita os que couberem", async () => {
    const estreito: DelegationLimits = { maxDepth: 2, maxChildren: 1, maxTotal: 8 };
    roteiro([
      delegar("A", "Primeira subtarefa descrita com detalhes suficientes.") +
        "\n" +
        delegar("B", "Segunda subtarefa descrita com detalhes suficientes."),
      "resultado A",
      "sintetizado"
    ]);
    const { final } = await correr("objetivo", estreito);
    expect(final.spawned).toBe(2); // raiz + 1
    expect(final.tasks[final.rootId].childIds).toHaveLength(1);
  });

  it("instrução curta demais é recusada sem gastar chamada", async () => {
    roteiro([toolBlock("delegate", { title: "X", task: "vai" }), "fiz eu mesmo"]);
    const { final } = await correr("objetivo");
    expect(final.spawned).toBe(1);
    // só 2 chamadas ao modelo: a que delegou mal e a que seguiu
    expect(chatOnceMock).toHaveBeenCalledTimes(2);
  });
});

describe("cancelamento", () => {
  it("abortar interrompe e marca o que estava em curso", async () => {
    const controller = new AbortController();
    chatOnceMock.mockImplementation(async () => {
      controller.abort();
      throw new Error("execução interrompida");
    });
    const { final } = await correr("objetivo", LIMITS, controller.signal);
    expect(final.tasks[final.rootId].status).toBe("cancelled");
  });
});

describe("ferramentas dentro do agente", () => {
  it("ferramenta comum é executada e o resultado realimenta o modelo", async () => {
    dispatchToolMock.mockResolvedValue({ ok: true, output: "conteúdo do arquivo" });
    roteiro([toolBlock("fs_read", { path: "a.txt" }), "li o arquivo"]);

    const { final } = await correr("ler o arquivo");
    expect(dispatchToolMock).toHaveBeenCalledTimes(1);
    const segunda = enviadas[1];
    expect(segunda[segunda.length - 1].content).toContain("conteúdo do arquivo");
    expect(final.tasks[final.rootId].report).toBe("li o arquivo");
  });

  /** Delegar não pode ser uma porta lateral para escrever sem aprovação. */
  it("ferramenta mutante do subordinado passa pela aprovação", async () => {
    dispatchToolMock.mockResolvedValue({ ok: true, output: "gravado" });
    roteiro([
      delegar("Gravar", "Escreva o resultado no arquivo de saída, conforme descrito."),
      toolBlock("fs_write", { path: "saida.md", content: "x" }),
      "gravei",
      "pronto"
    ]);

    const aprovacoes: string[] = [];
    await runAgentGoal({
      goal: "objetivo",
      selection: { kind: "workspace" },
      ctx: { session: null, runtimeRunning: false, fusionPresets: [] } as never,
      limits: LIMITS,
      root: "",
      signal: new AbortController().signal,
      hooks: {
        onTree: () => undefined,
        approve: async (task, call) => {
          aprovacoes.push(`${task.title}:${call.tool}`);
          return true;
        }
      }
    });

    expect(aprovacoes).toContain("Gravar:fs_write");
  });

  it("aprovação negada devolve recusa ao modelo em vez de executar", async () => {
    roteiro([toolBlock("fs_write", { path: "a.md", content: "x" }), "segui sem gravar"]);
    await runAgentGoal({
      goal: "objetivo",
      selection: { kind: "workspace" },
      ctx: { session: null, runtimeRunning: false, fusionPresets: [] } as never,
      limits: LIMITS,
      root: "",
      signal: new AbortController().signal,
      hooks: { onTree: () => undefined, approve: async () => false }
    });
    expect(dispatchToolMock).not.toHaveBeenCalled();
    const segunda = enviadas[1];
    expect(segunda[segunda.length - 1].content).toContain("recusada pelo usuário");
  });
});

describe("observabilidade", () => {
  it("a árvore é publicada a cada mudança, para a UI acompanhar ao vivo", async () => {
    roteiro([delegar("A", "Uma subtarefa descrita com detalhes suficientes."), "ok", "fim"]);
    const { vistas } = await correr("objetivo");
    expect(vistas.length).toBeGreaterThan(3);
    // em algum momento a árvore teve 2 agentes
    expect(vistas.some((state) => Object.keys(state.tasks).length === 2)).toBe(true);
  });
});
