/**
 * A exportação é serialização PURA sobre os envelopes do gateway — daí os
 * testes não terem rede nem DOM: um `get` falso pagina, e o resto é comparar
 * texto. O caso que importa mais é a paginação: exportar só a primeira página
 * perderia o fim de uma conversa longa em silêncio.
 */

import { describe, expect, it } from "vitest";
import type { Envelope } from "@aibot/contracts";
import { coletarEventos, eventosParaJson, eventosParaMarkdown, nomeDoArquivo } from "./sessionExport";

function mensagem(seq: number, role: "user" | "assistant" | "system", text: string, specialist?: string): Envelope {
  return {
    v: 1,
    id: `e${seq}`,
    ts: "2026-08-19T12:00:00Z",
    seq,
    session: "s1",
    turn: "t1",
    kind: "message",
    from: { kind: role === "user" ? "user" : "specialist", specialist },
    payload: { role, text, specialist }
  };
}

describe("coletarEventos", () => {
  it("pagina até o fim usando o último seq como cursor", async () => {
    // Duas páginas: a primeira CHEIA (500) força a segunda chamada.
    const primeira = Array.from({ length: 500 }, (_, i) => mensagem(i + 1, "user", `m${i + 1}`));
    const segunda = [mensagem(501, "assistant", "fim")];
    const chamadas: string[] = [];
    const get = (path: string) => {
      chamadas.push(path);
      return Promise.resolve(path.includes("from=0") ? primeira : segunda);
    };

    const eventos = await coletarEventos(get, "s1");
    expect(eventos).toHaveLength(501);
    expect(chamadas).toHaveLength(2);
    expect(chamadas[1]).toContain("from=500");
  });

  it("devolve vazio para sessão sem eventos", async () => {
    const eventos = await coletarEventos(() => Promise.resolve([]), "s1");
    expect(eventos).toEqual([]);
  });
});

describe("eventosParaMarkdown", () => {
  it("escreve só as falas, com autor, e ignora os verbos de máquina", () => {
    const eventos: Envelope[] = [
      mensagem(1, "user", "Como faço o deploy?"),
      { ...mensagem(2, "user", ""), kind: "route", payload: { specialist: "code" } },
      mensagem(3, "assistant", "Pelo pipeline.", "code")
    ];
    const md = eventosParaMarkdown(eventos, "Deploy");

    expect(md).toContain("# Deploy");
    expect(md).toContain("## Você");
    expect(md).toContain("Como faço o deploy?");
    expect(md).toContain("## Assistente (code)");
    expect(md).toContain("Pelo pipeline.");
    expect(md).not.toContain("route");
  });

  it("cai em 'Conversa' quando o título está vazio", () => {
    expect(eventosParaMarkdown([], "  ")).toContain("# Conversa");
  });
});

describe("eventosParaJson", () => {
  it("preserva os envelopes crus, re-parseáveis", () => {
    const eventos = [mensagem(1, "user", "oi")];
    const parsed = JSON.parse(eventosParaJson(eventos)) as Envelope[];
    expect(parsed).toEqual(eventos);
  });
});

describe("nomeDoArquivo", () => {
  it("deriva do título sem acento nem caractere de caminho", () => {
    expect(nomeDoArquivo("Revisão do módulo /transport", "s1", "md")).toBe("revisao-do-modulo-transport.md");
  });

  it("cai no id quando o título não rende nome", () => {
    expect(nomeDoArquivo("///", "s1", "json")).toBe("s1.json");
    expect(nomeDoArquivo("", "s1", "md")).toBe("s1.md");
  });
});
