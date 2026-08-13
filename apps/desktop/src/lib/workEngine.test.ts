import { beforeEach, describe, expect, it, vi } from "vitest";
import { addCard, emptyBoard, makeCard, type Rule } from "./automations";

/**
 * O engine é um módulo com efeito de importação (store + localStorage). Estes
 * testes cobrem a única decisão de segurança que ele toma: QUEM sai na hora e
 * quem fica esperando aprovação.
 */

// localStorage mínimo — o módulo persiste na criação do store.
const memoria = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (key: string) => memoria.get(key) ?? null,
  setItem: (key: string, value: string) => void memoria.set(key, value),
  removeItem: (key: string) => void memoria.delete(key)
});
vi.stubGlobal("window", { setInterval: () => 0 });

const drainMock = vi.fn(async () => [{ ok: true, line: "enviado" }]);
vi.mock("./workEffects", () => ({ drainEffects: (...args: unknown[]) => drainMock(...args) }));
vi.mock("./store", () => ({ useApp: { getState: () => ({ settings: { mcpServers: [] } }) } }));

const { useWork, withEvent, approveEffect, rejectEffect } = await import("./workEngine");

const externa = (partial: Partial<Rule> = {}): Rule => ({
  id: "r1",
  name: "Avisar TI",
  enabled: true,
  trigger: { kind: "card_created" },
  action: { kind: "webhook", secretRef: "wh1", label: "Teams" },
  ...partial
});

function estadoCom(rules: Rule[]) {
  const card = makeCard("Pagar fornecedor", { createdAt: 0 }, () => "c1");
  const board = addCard(emptyBoard(), "A fazer", card);
  return { prev: { board, rules, log: [], overdueSeen: [], pending: [] }, board, cardId: card.id };
}

beforeEach(() => {
  drainMock.mockClear();
  useWork.setState({ log: [], pending: [] });
});

describe("gate de aprovação", () => {
  it("regra externa sem flag NÃO envia — fica na fila", () => {
    const { prev, board, cardId } = estadoCom([externa()]);
    const next = withEvent(prev, board, { kind: "card_created", cardId });
    expect(drainMock).not.toHaveBeenCalled();
    expect(next.pending).toHaveLength(1);
    expect(next.log.some((item) => item.line.includes("aguardando aprovação"))).toBe(true);
  });

  it("requireApproval: true também segura", () => {
    const { prev, board, cardId } = estadoCom([externa({ requireApproval: true })]);
    const next = withEvent(prev, board, { kind: "card_created", cardId });
    expect(drainMock).not.toHaveBeenCalled();
    expect(next.pending).toHaveLength(1);
  });

  it("só requireApproval: false explícito envia direto", () => {
    const { prev, board, cardId } = estadoCom([externa({ requireApproval: false })]);
    const next = withEvent(prev, board, { kind: "card_created", cardId });
    expect(drainMock).toHaveBeenCalledTimes(1);
    expect(next.pending).toHaveLength(0);
  });

  /**
   * O caso que justifica o gate existir: `card_overdue` é disparado pelo
   * RELÓGIO do engine, sem ninguém na tela. Sem aprovação, o app chamaria
   * serviço de terceiro sozinho.
   */
  it("gatilho por vencimento (timer) também segura", () => {
    const { prev, board, cardId } = estadoCom([externa({ trigger: { kind: "card_overdue" } })]);
    const next = withEvent(prev, board, { kind: "card_overdue", cardId });
    expect(drainMock).not.toHaveBeenCalled();
    expect(next.pending).toHaveLength(1);
  });

  it("misturando as duas: a automática sai, a outra fica", () => {
    const { prev, board, cardId } = estadoCom([
      externa({ id: "auto", name: "Auto", requireApproval: false }),
      externa({ id: "gated", name: "Com gate", requireApproval: true })
    ]);
    const next = withEvent(prev, board, { kind: "card_created", cardId });
    expect(drainMock).toHaveBeenCalledTimes(1);
    // exatamente UM efeito foi enviado — o da regra automática
    expect((drainMock.mock.calls[0] as unknown[])[0]).toHaveLength(1);
    expect(next.pending).toHaveLength(1);
    expect(next.pending[0].effect.ruleName).toBe("Com gate");
  });

  it("ação interna não gera pendência nem envio", () => {
    const { prev, board, cardId } = estadoCom([
      externa({ action: { kind: "add_label", label: "urgente" } })
    ]);
    const next = withEvent(prev, board, { kind: "card_created", cardId });
    expect(next.pending).toHaveLength(0);
    expect(drainMock).not.toHaveBeenCalled();
  });
});

describe("aprovar e recusar", () => {
  it("aprovar tira da fila e envia", async () => {
    const { prev, board, cardId } = estadoCom([externa()]);
    useWork.setState(withEvent(prev, board, { kind: "card_created", cardId }));
    const [item] = useWork.getState().pending;
    approveEffect(item.id);
    expect(useWork.getState().pending).toHaveLength(0);
    await vi.waitFor(() => expect(drainMock).toHaveBeenCalledTimes(1));
  });

  it("recusar tira da fila SEM enviar e registra", () => {
    const { prev, board, cardId } = estadoCom([externa()]);
    useWork.setState(withEvent(prev, board, { kind: "card_created", cardId }));
    const [item] = useWork.getState().pending;
    rejectEffect(item.id);
    expect(useWork.getState().pending).toHaveLength(0);
    expect(drainMock).not.toHaveBeenCalled();
    expect(useWork.getState().log[0].line).toContain("recusada");
  });

  it("id inexistente é ignorado sem estourar", () => {
    approveEffect("nao-existe");
    rejectEffect("nao-existe");
    expect(drainMock).not.toHaveBeenCalled();
  });
});
