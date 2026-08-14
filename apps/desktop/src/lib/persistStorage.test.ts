import { describe, expect, it, vi } from "vitest";
import {
  criarArmazenamentoPersistido,
  podarMaisAntigas,
  type ArmazenamentoBruto
} from "./persistStorage";

/** Storage falso com relógio manual — o teste decide quando a janela fecha. */
function bancada(opcoes: { limite?: number } = {}) {
  const dados = new Map<string, string>();
  const escritas: string[] = [];
  let acaoAgendada: (() => void) | null = null;

  const bruto: ArmazenamentoBruto = {
    getItem: (chave) => dados.get(chave) ?? null,
    setItem: (chave, valor) => {
      if (opcoes.limite !== undefined && valor.length > opcoes.limite) {
        const erro = new Error("cota");
        erro.name = "QuotaExceededError";
        throw erro;
      }
      dados.set(chave, valor);
      escritas.push(valor);
    },
    removeItem: (chave) => void dados.delete(chave)
  };

  const avisos: string[] = [];
  const podas: number[] = [];
  const armazenamento = criarArmazenamentoPersistido(bruto, {
    agendar: (acao) => {
      acaoAgendada = acao;
      return 1;
    },
    cancelar: () => {
      acaoAgendada = null;
    },
    aoFalhar: (mensagem) => avisos.push(mensagem),
    aoPodar: (removidas) => podas.push(removidas)
  });

  return {
    armazenamento,
    dados,
    escritas,
    avisos,
    podas,
    /** Fecha a janela de coalescência. */
    correrRelogio: () => {
      const acao = acaoAgendada;
      acaoAgendada = null;
      acao?.();
    }
  };
}

const conversa = (id: string, quando: number) => ({ id, title: id, updatedAt: quando, messages: [] });

describe("criarArmazenamentoPersistido", () => {
  it("coalesce: dez escritas na mesma janela viram UMA, com o último valor", () => {
    const b = bancada();
    for (let i = 0; i < 10; i += 1) b.armazenamento.setItem("k", `v${i}`);
    expect(b.escritas).toHaveLength(0); // nada foi ao disco ainda

    b.correrRelogio();
    expect(b.escritas).toEqual(["v9"]);
  });

  it("valor idêntico ao gravado não escreve de novo", () => {
    const b = bancada();
    b.armazenamento.setItem("k", "igual");
    b.correrRelogio();
    expect(b.escritas).toEqual(["igual"]);

    // É o caso comum: `setInput` não muda nada do que é persistido, e o
    // `persist` mesmo assim manda gravar a cada tecla.
    for (let i = 0; i < 50; i += 1) b.armazenamento.setItem("k", "igual");
    b.correrRelogio();
    expect(b.escritas).toEqual(["igual"]);
  });

  it("getItem devolve o pendente, não a versão velha do disco", () => {
    const b = bancada();
    b.armazenamento.setItem("k", "antigo");
    b.correrRelogio();
    b.armazenamento.setItem("k", "novo");
    expect(b.armazenamento.getItem("k")).toBe("novo");
  });

  it("descarregar grava na hora — é o que salva o fechamento do app", () => {
    const b = bancada();
    b.armazenamento.setItem("k", "recém-digitado");
    b.armazenamento.descarregar();
    expect(b.dados.get("k")).toBe("recém-digitado");
  });

  it("descarregar sem nada pendente não escreve", () => {
    const b = bancada();
    b.armazenamento.descarregar();
    expect(b.escritas).toEqual([]);
  });

  it("removeItem cancela o pendente", () => {
    const b = bancada();
    b.armazenamento.setItem("k", "vai sumir");
    b.armazenamento.removeItem("k");
    b.correrRelogio();
    expect(b.escritas).toEqual([]);
    expect(b.dados.has("k")).toBe(false);
  });
});

describe("cota estourada", () => {
  const payload = (quantas: number) => {
    const lista = Array.from({ length: quantas }, (_, i) => conversa(`c${i}`, i));
    return JSON.stringify({ state: { conversations: { chat: lista } }, version: 0 });
  };

  it("poda as mais antigas e grava, em vez de derrubar a ação", () => {
    // Limite apertado o bastante para o payload cheio não caber, mas o podado
    // caber. É o cenário real: o histórico cresceu além dos ~5 MB.
    const cheio = payload(60);
    const b = bancada({ limite: cheio.length - 400 });

    b.armazenamento.setItem("orchestrator.v2", cheio);
    expect(() => b.correrRelogio()).not.toThrow();

    const gravado = b.dados.get("orchestrator.v2");
    expect(gravado).toBeDefined();
    const restantes = JSON.parse(gravado!).state.conversations.chat;
    expect(restantes.length).toBeLessThan(60);
    // As que ficaram são as mais RECENTES.
    expect(restantes[restantes.length - 1].id).toBe("c59");
    expect(b.podas.length).toBe(1);
    expect(b.avisos).toEqual([]);
  });

  it("quando nem podando cabe, avisa e NÃO relança", () => {
    // Relançar subiria de dentro do `setState` e mataria o envio da mensagem.
    const b = bancada({ limite: 1 });
    b.armazenamento.setItem("orchestrator.v2", payload(40));
    expect(() => b.correrRelogio()).not.toThrow();
    expect(b.avisos).toHaveLength(1);
    expect(b.avisos[0]).toContain("exporte as conversas");
  });

  it("erro que NÃO é de cota sobe — não é para engolir defeito", () => {
    const dados = new Map<string, string>();
    const armazenamento = criarArmazenamentoPersistido(
      {
        getItem: (chave) => dados.get(chave) ?? null,
        setItem: () => {
          throw new TypeError("storage quebrado");
        },
        removeItem: () => undefined
      },
      { agendar: (acao) => acao() as unknown }
    );
    expect(() => armazenamento.setItem("k", "v")).toThrow(TypeError);
  });
});

describe("podarMaisAntigas", () => {
  it("escolhe as mais antigas do CONJUNTO, atravessando as abas", () => {
    const json = JSON.stringify({
      state: {
        conversations: {
          chat: [conversa("chat-nova", 100), conversa("chat-velha", 1)],
          code: [conversa("code-media", 50)]
        }
      }
    });
    const podado = podarMaisAntigas(json, 2);
    const estado = JSON.parse(podado!).state.conversations;
    // Saíram a de updatedAt 1 e a de 50 — mesmo estando em abas diferentes.
    expect(estado.chat.map((c: { id: string }) => c.id)).toEqual(["chat-nova"]);
    expect(estado.code).toEqual([]);
  });

  it("devolve null quando não há conversa para podar", () => {
    expect(podarMaisAntigas(JSON.stringify({ state: {} }), 5)).toBeNull();
    expect(podarMaisAntigas(JSON.stringify({ state: { conversations: { chat: [] } } }), 5)).toBeNull();
    expect(podarMaisAntigas("não é json", 5)).toBeNull();
  });

  it("aceita o payload sem o invólucro do zustand", () => {
    const json = JSON.stringify({ conversations: { chat: [conversa("a", 1), conversa("b", 2)] } });
    const podado = podarMaisAntigas(json, 1);
    expect(JSON.parse(podado!).conversations.chat.map((c: { id: string }) => c.id)).toEqual(["b"]);
  });

  it("conversa sem updatedAt conta como a mais antiga", () => {
    const json = JSON.stringify({
      state: { conversations: { chat: [conversa("com-data", 10), { id: "sem-data", messages: [] }] } }
    });
    const podado = podarMaisAntigas(json, 1);
    expect(JSON.parse(podado!).state.conversations.chat.map((c: { id: string }) => c.id)).toEqual([
      "com-data"
    ]);
  });
});

describe("integração com o relógio real", () => {
  it("agenda uma única vez por janela", async () => {
    vi.useFakeTimers();
    const dados = new Map<string, string>();
    const escritas: string[] = [];
    const armazenamento = criarArmazenamentoPersistido(
      {
        getItem: (chave) => dados.get(chave) ?? null,
        setItem: (chave, valor) => {
          dados.set(chave, valor);
          escritas.push(valor);
        },
        removeItem: () => undefined
      },
      { intervalo: 1000 }
    );

    armazenamento.setItem("k", "a");
    armazenamento.setItem("k", "b");
    vi.advanceTimersByTime(999);
    expect(escritas).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(escritas).toEqual(["b"]);

    armazenamento.setItem("k", "c");
    vi.advanceTimersByTime(1000);
    expect(escritas).toEqual(["b", "c"]);
    vi.useRealTimers();
  });
});
