import { describe, expect, it } from "vitest";
import { collectConnections, shortRemote, summarize, type ConnectionsInput } from "./connections";

const input = (patch: Partial<ConnectionsInput> = {}): ConnectionsInput => ({
  gateway: { configured: false, connected: false },
  runtime: { running: false },
  servers: [],
  mcpServers: [],
  ...patch
});

describe("collectConnections", () => {
  it("nada configurado devolve lista vazia", () => {
    expect(collectConnections(input())).toEqual([]);
  });

  it("gateway configurado aparece mesmo fora do ar — o usuário precisa saber", () => {
    const list = collectConnections(input({ gateway: { configured: true, connected: false, baseUrl: "http://x" } }));
    expect(list).toEqual([{ kind: "gateway", label: "Gateway", state: "offline", detail: "http://x" }]);
  });

  it("runtime local só aparece rodando", () => {
    expect(collectConnections(input({ runtime: { running: false } }))).toEqual([]);
    expect(collectConnections(input({ runtime: { running: true, model: "qwen" } }))[0]).toMatchObject({
      kind: "runtime",
      state: "online"
    });
  });

  it("VPS cadastrado NÃO é VPS conectado", () => {
    const semTeste = collectConnections(input({ servers: [{ name: "VPS", host: "h", enabled: true }] }));
    expect(semTeste[0].state).toBe("configured");

    const ok = collectConnections(input({ servers: [{ name: "VPS", host: "h", enabled: true, lastTestOutcome: "ok" }] }));
    expect(ok[0].state).toBe("online");

    const falhou = collectConnections(
      input({ servers: [{ name: "VPS", host: "h", enabled: true, lastTestOutcome: "failed" }] })
    );
    expect(falhou[0].state).toBe("error");
  });

  it("servidor desabilitado não entra", () => {
    expect(collectConnections(input({ servers: [{ name: "VPS", host: "h", enabled: false }] }))).toEqual([]);
  });

  it("repositório e WSL entram quando detectados", () => {
    const list = collectConnections(
      input({
        repo: { remote: "https://github.com/acme/api.git", branch: "main" },
        wsl: { distro: "Ubuntu", running: true }
      })
    );
    expect(list.map((item) => item.label)).toEqual(["acme/api", "WSL · Ubuntu"]);
    expect(list[0].detail).toBe("branch main");
  });

  it("MCP habilitado mas não conectado fica como cadastrado", () => {
    const list = collectConnections(input({ mcpServers: [{ name: "figma", enabled: true }] }));
    expect(list[0]).toMatchObject({ kind: "mcp", state: "configured" });
  });

  it("junta tudo na ordem esperada", () => {
    const list = collectConnections(
      input({
        gateway: { configured: true, connected: true },
        runtime: { running: true },
        servers: [{ name: "VPS", host: "h", enabled: true, lastTestOutcome: "ok" }],
        repo: { remote: "acme/api" },
        wsl: { distro: "Ubuntu", running: true },
        mcpServers: [{ name: "figma", enabled: true, connected: true }]
      })
    );
    expect(list.map((item) => item.kind)).toEqual(["gateway", "runtime", "vps", "git", "wsl", "mcp"]);
  });
});

describe("shortRemote", () => {
  it("resume as formas usuais de remote", () => {
    expect(shortRemote("https://github.com/acme/api.git")).toBe("acme/api");
    expect(shortRemote("git@github.com:acme/api.git")).toBe("acme/api");
    expect(shortRemote("acme/api")).toBe("acme/api");
  });

  it("remote esquisito ainda produz rótulo — nunca vazio", () => {
    expect(shortRemote("file:///tmp/repo")).toBe("tmp/repo");
    expect(shortRemote("servidor-interno")).toBe("servidor-interno");
    expect(shortRemote("")).toBe("");
  });
});

describe("summarize", () => {
  it("sem conexão viva continua dizendo Desconectado — é a verdade", () => {
    expect(summarize([])).toEqual({ label: "Desconectado", online: false });
    expect(summarize([{ kind: "vps", label: "VPS", state: "configured" }])).toEqual({
      label: "Desconectado",
      online: false
    });
  });

  it("uma conexão viva mostra QUAL", () => {
    expect(summarize([{ kind: "gateway", label: "Gateway", state: "online" }])).toEqual({
      label: "Gateway",
      online: true
    });
  });

  it("várias conexões vivas contam", () => {
    const many = summarize([
      { kind: "gateway", label: "Gateway", state: "online" },
      { kind: "vps", label: "VPS", state: "online" },
      { kind: "git", label: "acme/api", state: "online" }
    ]);
    expect(many).toEqual({ label: "3 conexões", online: true });
  });

  it("conexão com erro não conta como viva", () => {
    expect(
      summarize([
        { kind: "vps", label: "VPS", state: "error" },
        { kind: "gateway", label: "Gateway", state: "online" }
      ])
    ).toEqual({ label: "Gateway", online: true });
  });
});
