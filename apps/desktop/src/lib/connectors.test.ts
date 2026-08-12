import { describe, expect, it } from "vitest";
import {
  CONNECTOR_CATALOG,
  connectorState,
  environmentLabel,
  filterConnectors,
  type Connector
} from "./connectors";

const find = (id: string): Connector => {
  const hit = CONNECTOR_CATALOG.find((connector) => connector.id === id);
  if (!hit) throw new Error(`conector ${id} ausente do catálogo`);
  return hit;
};

describe("connectorState", () => {
  it("sem servidores, tudo aprovado fica disponível", () => {
    expect(connectorState(find("slack"), [])).toBe("available");
  });

  it("casa conectado por id OU por nome, sem diferenciar caixa", () => {
    expect(connectorState(find("slack"), [{ name: "Slack" }])).toBe("connected");
    expect(connectorState(find("slack"), [{ name: "slack" }])).toBe("connected");
    expect(connectorState(find("microsoft-365"), [{ name: "microsoft-365" }])).toBe("connected");
  });

  it("allow-list do admin bloqueia o que não está aprovado", () => {
    expect(connectorState(find("discord"), [], ["slack", "gmail"])).toBe("blocked");
    expect(connectorState(find("slack"), [], ["slack", "gmail"])).toBe("available");
  });

  it("allow-list ausente não bloqueia nada (gating não configurado)", () => {
    expect(connectorState(find("discord"), [], null)).toBe("available");
    expect(connectorState(find("discord"), [], undefined)).toBe("available");
  });

  it("bloqueado vence conectado: fora da allow-list nem aparece como ligado", () => {
    expect(connectorState(find("slack"), [{ name: "Slack" }], ["gmail"])).toBe("blocked");
  });
});

describe("filterConnectors", () => {
  it("sem filtro devolve o catálogo inteiro", () => {
    expect(filterConnectors(CONNECTOR_CATALOG, {})).toHaveLength(CONNECTOR_CATALOG.length);
  });

  it("filtra por categoria", () => {
    const design = filterConnectors(CONNECTOR_CATALOG, { category: "design" });
    expect(design.map((c) => c.id).sort()).toEqual(["canva", "figma"]);
  });

  it("todos ignora a categoria", () => {
    expect(filterConnectors(CONNECTOR_CATALOG, { category: "todos" })).toHaveLength(CONNECTOR_CATALOG.length);
  });

  it("busca casa nome e descrição, sem caixa", () => {
    expect(filterConnectors(CONNECTOR_CATALOG, { query: "SLACK" }).map((c) => c.id)).toEqual(["slack"]);
    expect(filterConnectors(CONNECTOR_CATALOG, { query: "workflow" }).map((c) => c.id)).toEqual(["n8n"]);
  });

  it("categoria e busca combinam", () => {
    expect(filterConnectors(CONNECTOR_CATALOG, { category: "design", query: "canva" }).map((c) => c.id)).toEqual([
      "canva"
    ]);
    expect(filterConnectors(CONNECTOR_CATALOG, { category: "dev", query: "canva" })).toEqual([]);
  });
});

describe("environmentLabel", () => {
  it("rotula cada ambiente e cai em Local no desconhecido", () => {
    expect(environmentLabel("local")).toBe("Local");
    expect(environmentLabel("wsl")).toBe("WSL");
    expect(environmentLabel("vps")).toBe("VPS");
    expect(environmentLabel("cloud")).toBe("Nuvem");
  });
});

describe("catálogo", () => {
  it("todo conector tem categoria conhecida e descrição", () => {
    for (const connector of CONNECTOR_CATALOG) {
      expect(connector.description.length).toBeGreaterThan(10);
      expect(connector.id).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it("ids são únicos", () => {
    const ids = CONNECTOR_CATALOG.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
