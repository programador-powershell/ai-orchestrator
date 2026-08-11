import { describe, expect, it } from "vitest";
import {
  addCard,
  DEFAULT_LANES,
  describeAction,
  describeTrigger,
  emptyBoard,
  exportBoardMarkdown,
  findCard,
  findCardByTitle,
  isOverdue,
  makeCard,
  MAX_CHAIN,
  moveCard,
  parseBoardMarkdown,
  removeCard,
  ruleFromTexts,
  runRules,
  todayISO,
  updateCard,
  type Board,
  type Rule
} from "./automations";

/** id determinístico para os testes */
const idGen = () => {
  let counter = 0;
  return () => `id-${++counter}`;
};

const rule = (partial: Partial<Rule> & Pick<Rule, "trigger" | "action">): Rule => ({
  id: partial.id ?? "r1",
  name: partial.name ?? "regra",
  enabled: partial.enabled ?? true,
  trigger: partial.trigger,
  action: partial.action
});

function boardWith(cardTitle: string, lane = "A fazer"): { board: Board; cardId: string } {
  const card = makeCard(cardTitle, { createdAt: 0 }, () => "c1");
  return { board: addCard(emptyBoard(), lane, card), cardId: card.id };
}

/* ------------------------------ helpers ------------------------------ */

describe("emptyBoard e helpers do quadro", () => {
  it("cria quadro vazio com as 3 colunas padrão e zero cartões", () => {
    const board = emptyBoard();
    expect(board.lanes.map((lane) => lane.name)).toEqual([...DEFAULT_LANES]);
    expect(board.lanes.every((lane) => lane.cards.length === 0)).toBe(true);
  });

  it("addCard cria a coluna quando não existe e não muta o original", () => {
    const original = emptyBoard();
    const next = addCard(original, "Backlog", makeCard("A", { createdAt: 0 }, () => "c1"));
    expect(next.lanes.map((lane) => lane.name)).toContain("Backlog");
    expect(original.lanes).toHaveLength(3);
    expect(findCard(next, "c1")?.lane.name).toBe("Backlog");
  });

  it("moveCard move entre colunas e é no-op na mesma coluna", () => {
    const { board, cardId } = boardWith("A");
    const moved = moveCard(board, cardId, "Concluído");
    expect(moved.moved).toBe(true);
    expect(findCard(moved.board, cardId)?.lane.name).toBe("Concluído");
    const again = moveCard(moved.board, cardId, "concluído"); // case-insensitive
    expect(again.moved).toBe(false);
    expect(findCard(board, cardId)?.lane.name).toBe("A fazer"); // original intacto
  });

  it("updateCard e removeCard são imutáveis", () => {
    const { board, cardId } = boardWith("A");
    const updated = updateCard(board, cardId, { labels: ["urgente"], due: "2026-01-01" });
    expect(findCard(updated, cardId)?.card.labels).toEqual(["urgente"]);
    expect(findCard(board, cardId)?.card.labels).toEqual([]);
    const removed = removeCard(updated, cardId);
    expect(findCard(removed, cardId)).toBeNull();
    expect(findCard(updated, cardId)).not.toBeNull();
  });

  it("findCardByTitle localiza por título case-insensitive", () => {
    const { board } = boardWith("Revisar Contrato");
    expect(findCardByTitle(board, "revisar contrato")?.id).toBe("c1");
    expect(findCardByTitle(board, "inexistente")).toBeNull();
  });
});

/* ----------------------------- due dates ----------------------------- */

describe("isOverdue / todayISO", () => {
  it("todayISO formata data local como YYYY-MM-DD", () => {
    expect(todayISO(new Date(2026, 7, 10))).toBe("2026-08-10");
    expect(todayISO(new Date(2026, 0, 5))).toBe("2026-01-05");
  });

  it("atrasado apenas quando due é anterior a hoje", () => {
    expect(isOverdue("2026-08-09", "2026-08-10")).toBe(true);
    expect(isOverdue("2026-08-10", "2026-08-10")).toBe(false);
    expect(isOverdue("2026-08-11", "2026-08-10")).toBe(false);
    expect(isOverdue(null, "2026-08-10")).toBe(false);
  });
});

/* ------------------------------ runRules ----------------------------- */

describe("runRules — triggers", () => {
  it("card_created + add_label etiqueta o cartão", () => {
    const { board, cardId } = boardWith("Deploy");
    const rules = [rule({ trigger: { kind: "card_created" }, action: { kind: "add_label", label: "novo" } })];
    const result = runRules(board, { kind: "card_created", cardId }, rules);
    expect(findCard(result.board, cardId)?.card.labels).toEqual(["novo"]);
    expect(result.log).toHaveLength(1);
    expect(result.log[0]).toContain('etiquetou "Deploy"');
  });

  it("card_created respeita o filtro titleContains (case-insensitive)", () => {
    const { board, cardId } = boardWith("Bug no login");
    const rules = [
      rule({
        trigger: { kind: "card_created", titleContains: "bug" },
        action: { kind: "add_label", label: "bug" }
      })
    ];
    const hit = runRules(board, { kind: "card_created", cardId }, rules);
    expect(findCard(hit.board, cardId)?.card.labels).toEqual(["bug"]);

    const other = boardWith("Feature X");
    const miss = runRules(other.board, { kind: "card_created", cardId: other.cardId }, rules);
    expect(miss.log).toEqual([]);
    expect(miss.board).toBe(other.board);
  });

  it("card_moved respeita o filtro toLane e sem filtro casa qualquer coluna", () => {
    const { board, cardId } = boardWith("A", "Em andamento");
    const filtered = [
      rule({
        trigger: { kind: "card_moved", toLane: "Concluído" },
        action: { kind: "add_label", label: "done" }
      })
    ];
    const miss = runRules(board, { kind: "card_moved", cardId, toLane: "Em andamento" }, filtered);
    expect(miss.log).toEqual([]);
    const hit = runRules(board, { kind: "card_moved", cardId, toLane: "concluído" }, filtered);
    expect(hit.log).toHaveLength(1);

    const anyLane = [rule({ trigger: { kind: "card_moved" }, action: { kind: "add_label", label: "movido" } })];
    const any = runRules(board, { kind: "card_moved", cardId, toLane: "Qualquer" }, anyLane);
    expect(findCard(any.board, cardId)?.card.labels).toEqual(["movido"]);
  });

  it("card_overdue dispara move_to", () => {
    const { board, cardId } = boardWith("Atrasada");
    const rules = [rule({ trigger: { kind: "card_overdue" }, action: { kind: "move_to", lane: "Em andamento" } })];
    const result = runRules(board, { kind: "card_overdue", cardId }, rules);
    expect(findCard(result.board, cardId)?.lane.name).toBe("Em andamento");
    expect(result.log[0]).toContain('moveu "Atrasada" para "Em andamento"');
  });
});

describe("runRules — actions", () => {
  it("create_card cria cartão na coluna indicada com id novo", () => {
    const { board, cardId } = boardWith("Origem");
    const rules = [
      rule({
        trigger: { kind: "card_overdue" },
        action: { kind: "create_card", lane: "A fazer", title: "Follow-up" }
      })
    ];
    const result = runRules(board, { kind: "card_overdue", cardId }, rules, { newId: idGen() });
    const created = findCardByTitle(result.board, "Follow-up");
    expect(created).not.toBeNull();
    expect(created?.id).toBe("id-1");
    expect(result.log[0]).toContain('criou "Follow-up" em "A fazer"');
  });

  it("add_label duplicada é no-op sem log", () => {
    const { board, cardId } = boardWith("A");
    const labeled = updateCard(board, cardId, { labels: ["novo"] });
    const rules = [rule({ trigger: { kind: "card_created" }, action: { kind: "add_label", label: "NOVO" } })];
    const result = runRules(labeled, { kind: "card_created", cardId }, rules);
    expect(result.log).toEqual([]);
    expect(findCard(result.board, cardId)?.card.labels).toEqual(["novo"]);
  });

  it("move_to para a coluna atual é no-op sem log", () => {
    const { board, cardId } = boardWith("A", "Concluído");
    const rules = [
      rule({
        trigger: { kind: "card_moved", toLane: "Concluído" },
        action: { kind: "move_to", lane: "Concluído" }
      })
    ];
    const result = runRules(board, { kind: "card_moved", cardId, toLane: "Concluído" }, rules);
    expect(result.log).toEqual([]);
  });

  it("regra desabilitada não roda", () => {
    const { board, cardId } = boardWith("A");
    const rules = [
      rule({ enabled: false, trigger: { kind: "card_created" }, action: { kind: "add_label", label: "x" } })
    ];
    const result = runRules(board, { kind: "card_created", cardId }, rules);
    expect(result.log).toEqual([]);
    expect(result.board).toBe(board);
  });

  it("não muta o quadro de entrada", () => {
    const { board, cardId } = boardWith("A");
    const snapshot = JSON.parse(JSON.stringify(board)) as Board;
    runRules(board, { kind: "card_created", cardId }, [
      rule({ trigger: { kind: "card_created" }, action: { kind: "move_to", lane: "Concluído" } })
    ]);
    expect(board).toEqual(snapshot);
  });
});

describe("runRules — encadeamento e anti-loop", () => {
  it("encadeia: criado → move para Em andamento → etiqueta ao chegar", () => {
    const { board, cardId } = boardWith("Card");
    const rules = [
      rule({
        id: "r1",
        name: "mover novos",
        trigger: { kind: "card_created" },
        action: { kind: "move_to", lane: "Em andamento" }
      }),
      rule({
        id: "r2",
        name: "etiquetar andamento",
        trigger: { kind: "card_moved", toLane: "Em andamento" },
        action: { kind: "add_label", label: "wip" }
      })
    ];
    const result = runRules(board, { kind: "card_created", cardId }, rules);
    const hit = findCard(result.board, cardId);
    expect(hit?.lane.name).toBe("Em andamento");
    expect(hit?.card.labels).toEqual(["wip"]);
    expect(result.log).toHaveLength(2);
  });

  it("anti-loop: ping-pong entre colunas para após MAX_CHAIN derivações", () => {
    const { board, cardId } = boardWith("Ping", "B");
    const rules = [
      rule({
        id: "ab",
        name: "B→C",
        trigger: { kind: "card_moved", toLane: "B" },
        action: { kind: "move_to", lane: "C" }
      }),
      rule({
        id: "ba",
        name: "C→B",
        trigger: { kind: "card_moved", toLane: "C" },
        action: { kind: "move_to", lane: "B" }
      })
    ];
    const result = runRules(board, { kind: "card_moved", cardId, toLane: "B" }, rules);
    const moves = result.log.filter((line) => line.includes("moveu"));
    const cuts = result.log.filter((line) => line.startsWith("anti-loop"));
    expect(moves).toHaveLength(MAX_CHAIN + 1); // evento original + 5 derivados
    expect(cuts).toHaveLength(1);
    expect(findCard(result.board, cardId)).not.toBeNull(); // terminou, não travou
  });

  it("create_card que se auto-dispara também é limitado", () => {
    const { board, cardId } = boardWith("Semente");
    const rules = [
      rule({
        name: "clonar",
        trigger: { kind: "card_created" },
        action: { kind: "create_card", lane: "A fazer", title: "Clone" }
      })
    ];
    const result = runRules(board, { kind: "card_created", cardId }, rules, { newId: idGen() });
    const clones = result.log.filter((line) => line.includes("criou"));
    expect(clones).toHaveLength(MAX_CHAIN + 1);
    expect(result.log.at(-1)).toContain("anti-loop");
  });
});

/* --------------------------- descrições ------------------------------ */

describe("describeTrigger / describeAction", () => {
  it("descreve cada tipo em português", () => {
    expect(describeTrigger({ kind: "card_moved", toLane: "Concluído" })).toContain("Concluído");
    expect(describeTrigger({ kind: "card_moved" })).toContain("qualquer coluna");
    expect(describeTrigger({ kind: "card_created", titleContains: "bug" })).toContain("bug");
    expect(describeTrigger({ kind: "card_overdue" })).toContain("atrasado");
    expect(describeAction({ kind: "move_to", lane: "X" })).toBe('mover para "X"');
    expect(describeAction({ kind: "add_label", label: "y" })).toBe('adicionar etiqueta "y"');
    expect(describeAction({ kind: "create_card", lane: "L", title: "T" })).toContain('"T"');
  });
});

/* ------------------------- ruleFromTexts ----------------------------- */

describe("ruleFromTexts (op add_automation do chat)", () => {
  it("movido para X → mover para Y", () => {
    const parsed = ruleFromTexts("r", "cartão movido para Concluído", "mover para Arquivo", () => "r1");
    expect(parsed?.trigger).toEqual({ kind: "card_moved", toLane: "Concluído" });
    expect(parsed?.action).toEqual({ kind: "move_to", lane: "Arquivo" });
    expect(parsed?.enabled).toBe(true);
  });

  it("cartão criado contendo texto → etiquetar", () => {
    const parsed = ruleFromTexts("r", 'cartão criado contendo "bug"', 'adicionar etiqueta "urgente"');
    expect(parsed?.trigger).toEqual({ kind: "card_created", titleContains: "bug" });
    expect(parsed?.action).toEqual({ kind: "add_label", label: "urgente" });
  });

  it("cartão atrasado → criar cartão", () => {
    const parsed = ruleFromTexts("r", "cartão atrasado", 'criar cartão "Cobrar" em A fazer');
    expect(parsed?.trigger).toEqual({ kind: "card_overdue" });
    expect(parsed?.action).toEqual({ kind: "create_card", lane: "A fazer", title: "Cobrar" });
  });

  it("texto não reconhecido devolve null (nada é simulado)", () => {
    expect(ruleFromTexts("r", "quando a lua estiver cheia", "uivar")).toBeNull();
    expect(ruleFromTexts("r", "cartão movido", "fazer algo vago")).toBeNull();
  });
});

/* ---------------------- Markdown round-trip -------------------------- */

describe("exportBoardMarkdown / parseBoardMarkdown", () => {
  const normalize = (board: Board) =>
    board.lanes.map((lane) => ({
      name: lane.name,
      cards: lane.cards.map(({ title, detail, labels, due }) => ({ title, detail, labels, due }))
    }));

  it("round-trip preserva colunas, títulos, labels, due e descrição", () => {
    let board = emptyBoard();
    board = addCard(
      board,
      "A fazer",
      makeCard("Revisar contrato", { detail: "Cláusula 3 pendente", labels: ["jurídico", "urgente"], due: "2026-08-15", createdAt: 0 }, () => "a")
    );
    board = addCard(board, "Em andamento", makeCard("Deploy staging", { createdAt: 0 }, () => "b"));
    board = addCard(
      board,
      "Concluído",
      makeCard("Kickoff", { detail: "Feito em reunião", labels: ["squad"], createdAt: 0 }, () => "c")
    );

    const markdown = exportBoardMarkdown(board);
    expect(markdown).toContain("## A fazer");
    expect(markdown).toContain("- [ ] Revisar contrato");
    expect(markdown).toContain("labels: jurídico, urgente");
    expect(markdown).toContain("due: 2026-08-15");
    expect(markdown).toContain("- [x] Kickoff"); // concluído marca [x]

    const parsed = parseBoardMarkdown(markdown, idGen());
    expect(normalize(parsed)).toEqual(normalize(board));
  });

  it("round-trip do quadro vazio mantém as 3 colunas", () => {
    const parsed = parseBoardMarkdown(exportBoardMarkdown(emptyBoard()));
    expect(parsed.lanes.map((lane) => lane.name)).toEqual([...DEFAULT_LANES]);
    expect(parsed.lanes.every((lane) => lane.cards.length === 0)).toBe(true);
  });

  it("ignora due malformado e linhas estranhas sem quebrar", () => {
    const markdown = [
      "# Quadro Work",
      "texto solto que não é cartão",
      "## Coluna",
      "- [ ] Card",
      "  due: não-é-data",
      "  labels: a,, b ,",
      "  desc: ok"
    ].join("\n");
    const parsed = parseBoardMarkdown(markdown);
    expect(parsed.lanes).toHaveLength(1);
    const card = parsed.lanes[0].cards[0];
    expect(card.due).toBeNull();
    expect(card.labels).toEqual(["a", "b"]);
    expect(card.detail).toBe("ok");
  });
});
