import { describe, expect, it } from "vitest";
import { addNode, createDoc, updateNode, type CanvasDoc, type CanvasNode } from "./canvasDoc";
import {
  canRedo,
  canUndo,
  COALESCE_WINDOW_MS,
  createHistory,
  HISTORY_LIMIT,
  pushHistory,
  pushHistoryCoalesced,
  redo,
  undo,
  type DocHistory
} from "./history";

const rect = (id: string, x = 0): CanvasNode => ({ id, type: "rect", x, y: 0, w: 100, h: 50, fill: "#ff0000" });

/** Simula o ciclo real da superfície: pushHistory(estado atual) → aplicar edição. */
function edita(history: DocHistory, doc: CanvasDoc, x: number, now = 0): { history: DocHistory; doc: CanvasDoc } {
  return { history: pushHistory(history, doc, now), doc: updateNode(doc, "rect-1", { x }) };
}

describe("pushHistory / undo", () => {
  it("desfaz devolve o estado registrado antes da edição", () => {
    const base = addNode(createDoc(), rect("rect-1"));
    const { history, doc } = edita(createHistory(), base, 50);
    expect(doc.nodes.find((n) => n.id === "rect-1")?.x).toBe(50);

    const step = undo(history, doc);
    expect(step).not.toBeNull();
    expect(step!.doc).toBe(base); // mesma referência: undo é troca de ponteiro
    expect(canUndo(step!.history)).toBe(false);
  });

  it("desfaz em cadeia volta passo a passo", () => {
    const base = addNode(createDoc(), rect("rect-1"));
    let state = edita(createHistory(), base, 10);
    state = edita(state.history, state.doc, 20);
    state = edita(state.history, state.doc, 30);

    const um = undo(state.history, state.doc)!;
    expect(um.doc.nodes.find((n) => n.id === "rect-1")?.x).toBe(20);
    const dois = undo(um.history, um.doc)!;
    expect(dois.doc.nodes.find((n) => n.id === "rect-1")?.x).toBe(10);
    const tres = undo(dois.history, dois.doc)!;
    expect(tres.doc).toBe(base);
    expect(undo(tres.history, tres.doc)).toBeNull();
  });

  it("undo sem histórico devolve null — Ctrl+Z chega mesmo com botão desabilitado", () => {
    expect(undo(createHistory(), createDoc())).toBeNull();
  });

  it("não muta o histórico anterior (estrutura pura)", () => {
    const history = createHistory();
    const doc = createDoc();
    pushHistory(history, doc);
    expect(history.past).toHaveLength(0);
  });
});

describe("redo", () => {
  it("refaz o que o undo desfez", () => {
    const base = addNode(createDoc(), rect("rect-1"));
    const { history, doc } = edita(createHistory(), base, 50);

    const desfeito = undo(history, doc)!;
    expect(canRedo(desfeito.history)).toBe(true);
    const refeito = redo(desfeito.history, desfeito.doc)!;
    expect(refeito.doc).toBe(doc);
    expect(canRedo(refeito.history)).toBe(false);
    expect(canUndo(refeito.history)).toBe(true);
  });

  it("refaz em cadeia na ordem certa", () => {
    const base = addNode(createDoc(), rect("rect-1"));
    let state = edita(createHistory(), base, 10);
    state = edita(state.history, state.doc, 20);

    const u1 = undo(state.history, state.doc)!;
    const u2 = undo(u1.history, u1.doc)!;
    const r1 = redo(u2.history, u2.doc)!;
    expect(r1.doc.nodes.find((n) => n.id === "rect-1")?.x).toBe(10);
    const r2 = redo(r1.history, r1.doc)!;
    expect(r2.doc.nodes.find((n) => n.id === "rect-1")?.x).toBe(20);
    expect(redo(r2.history, r2.doc)).toBeNull();
  });

  /** O padrão de todo editor: editar depois de desfazer descarta o ramo refazível. */
  it("push novo apaga o future — não existe refazer para um ramo abandonado", () => {
    const base = addNode(createDoc(), rect("rect-1"));
    const { history, doc } = edita(createHistory(), base, 50);
    const desfeito = undo(history, doc)!;
    const outroRamo = pushHistory(desfeito.history, desfeito.doc);
    expect(canRedo(outroRamo)).toBe(false);
  });

  it("redo sem future devolve null", () => {
    expect(redo(createHistory(), createDoc())).toBeNull();
  });
});

describe("teto de 50 estados", () => {
  it("nunca guarda mais que HISTORY_LIMIT e descarta o mais antigo", () => {
    const base = addNode(createDoc(), rect("rect-1"));
    let state = { history: createHistory(), doc: base };
    for (let i = 1; i <= HISTORY_LIMIT + 10; i += 1) {
      state = edita(state.history, state.doc, i);
    }
    expect(state.history.past).toHaveLength(HISTORY_LIMIT);

    // Desfazendo tudo, o estado mais antigo alcançável é o de x=10 (os dez
    // primeiros caíram da pilha) — não o documento original.
    let cursor = state;
    let passos = 0;
    for (;;) {
      const step = undo(cursor.history, cursor.doc);
      if (!step) break;
      cursor = step;
      passos += 1;
    }
    expect(passos).toBe(HISTORY_LIMIT);
    expect(cursor.doc.nodes.find((n) => n.id === "rect-1")?.x).toBe(10);
  });

  it("o teto vale também para o caminho do redo", () => {
    const base = addNode(createDoc(), rect("rect-1"));
    let state = { history: createHistory(), doc: base };
    for (let i = 1; i <= HISTORY_LIMIT; i += 1) {
      state = edita(state.history, state.doc, i);
    }
    const desfeito = undo(state.history, state.doc)!;
    const refeito = redo(desfeito.history, desfeito.doc)!;
    expect(refeito.history.past.length).toBeLessThanOrEqual(HISTORY_LIMIT);
  });
});

describe("pushHistoryCoalesced", () => {
  it("agrupa edições dentro da janela — digitar '320' não vira três entradas", () => {
    const base = addNode(createDoc(), rect("rect-1"));
    const primeira = pushHistoryCoalesced(createHistory(), base, 1000);
    expect(primeira.past).toHaveLength(1);

    const doc2 = updateNode(base, "rect-1", { x: 3 });
    const segunda = pushHistoryCoalesced(primeira, doc2, 1000 + COALESCE_WINDOW_MS - 1);
    expect(segunda).toBe(primeira); // ignorado: a entrada da 1ª tecla segue valendo
  });

  it("fora da janela registra normalmente", () => {
    const base = addNode(createDoc(), rect("rect-1"));
    const primeira = pushHistoryCoalesced(createHistory(), base, 1000);
    const doc2 = updateNode(base, "rect-1", { x: 3 });
    const segunda = pushHistoryCoalesced(primeira, doc2, 1000 + COALESCE_WINDOW_MS);
    expect(segunda.past).toHaveLength(2);
  });

  /** Sem zerar o relógio no undo, a 1ª edição pós-undo seria engolida. */
  it("edição logo depois de um undo não é engolida pela coalescência", () => {
    const base = addNode(createDoc(), rect("rect-1"));
    const history = pushHistory(createHistory(), base, 1000);
    const editado = updateNode(base, "rect-1", { x: 50 });

    const desfeito = undo(history, editado)!;
    const aposUndo = pushHistoryCoalesced(desfeito.history, desfeito.doc, 1001);
    expect(aposUndo.past).toHaveLength(1);
  });
});
