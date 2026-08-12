import { describe, expect, it } from "vitest";
import {
  emptyDraft,
  looksLikeSecret,
  needsConfirmation,
  newServer,
  passphraseAccount,
  remoteCommand,
  validateDraft,
  validateHost,
  validatePort,
  type DeployServer,
  type ServerDraft
} from "./server";

const draft = (patch: Partial<ServerDraft> = {}): ServerDraft => ({
  ...emptyDraft(),
  name: "VPS Openship",
  host: "deploy.exemplo.com",
  user: "deploy",
  ...patch
});

const fieldsOf = (issues: ReturnType<typeof validateDraft>) => issues.map((issue) => issue.field);

describe("validateHost", () => {
  it("aceita hostname e IPv4", () => {
    expect(validateHost("deploy.exemplo.com")).toBeUndefined();
    expect(validateHost("192.168.10.4")).toBeUndefined();
  });

  it("recusa esquema, caminho e porta embutida — cada um com a razão certa", () => {
    expect(validateHost("https://deploy.exemplo.com")).toContain("http://");
    expect(validateHost("deploy.exemplo.com/app")).toContain("caminho");
    expect(validateHost("deploy.exemplo.com:22")).toContain("porta");
  });

  it("recusa vazio e octeto fora da faixa", () => {
    expect(validateHost("  ")).toBeDefined();
    expect(validateHost("999.1.1.1")).toBeDefined();
  });
});

describe("validatePort", () => {
  it("aceita a faixa válida e recusa o resto", () => {
    expect(validatePort(22)).toBeUndefined();
    expect(validatePort(65535)).toBeUndefined();
    expect(validatePort(0)).toBeDefined();
    expect(validatePort(70000)).toBeDefined();
    expect(validatePort(22.5)).toBeDefined();
  });
});

describe("looksLikeSecret", () => {
  it("detecta material de chave privada em qualquer variante", () => {
    for (const kind of ["", "RSA ", "EC ", "OPENSSH "]) {
      expect(looksLikeSecret(`-----BEGIN ${kind}PRIVATE KEY-----\nMIIE...`)).toBe(true);
    }
  });

  it("não confunde um caminho comum com segredo", () => {
    expect(looksLikeSecret("C:\\Users\\daniel\\.ssh\\id_ed25519")).toBe(false);
  });
});

describe("validateDraft", () => {
  it("aceita um cadastro completo com agente SSH — sem digitar segredo nenhum", () => {
    expect(validateDraft(draft())).toEqual([]);
  });

  it("cobra os campos obrigatórios", () => {
    const issues = validateDraft(draft({ name: "", host: "", user: "", remoteWorkdir: "" }));
    expect(fieldsOf(issues)).toEqual(expect.arrayContaining(["name", "host", "user", "remoteWorkdir"]));
  });

  it("keyFile exige o caminho da chave", () => {
    expect(fieldsOf(validateDraft(draft({ authMethod: "keyFile" })))).toContain("keyPath");
    expect(validateDraft(draft({ authMethod: "keyFile", keyPath: "~/.ssh/id_ed25519" }))).toEqual([]);
  });

  it("RECUSA a chave privada colada no campo de caminho e manda para o cofre", () => {
    const issues = validateDraft(draft({ authMethod: "keyFile", keyPath: "-----BEGIN OPENSSH PRIVATE KEY-----\nabc" }));
    expect(fieldsOf(issues)).toContain("secret");
    expect(issues.find((issue) => issue.field === "secret")?.message).toContain("cofre");
  });

  it("workdir precisa ser caminho absoluto", () => {
    expect(fieldsOf(validateDraft(draft({ remoteWorkdir: "opt/app" })))).toContain("remoteWorkdir");
  });

  it("painel do Openship só por https", () => {
    expect(fieldsOf(validateDraft(draft({ openshipUrl: "http://painel.exemplo.com" })))).toContain("openshipUrl");
    expect(validateDraft(draft({ openshipUrl: "https://painel.exemplo.com" }))).toEqual([]);
  });
});

describe("emptyDraft", () => {
  it("nasce no método mais seguro: agente SSH, sem segredo no app", () => {
    expect(emptyDraft().authMethod).toBe("agent");
    expect(emptyDraft().port).toBe(22);
  });

  it("não tem campo de senha nem de conteúdo de chave", () => {
    expect(Object.keys(emptyDraft())).not.toEqual(expect.arrayContaining(["password", "privateKey", "passphrase"]));
  });
});

describe("newServer", () => {
  it("normaliza espaços e nasce habilitado", () => {
    const server = newServer("s1", draft({ name: "  VPS  ", host: " x.com " }), "2026-08-12T00:00:00Z");
    expect(server).toMatchObject({ id: "s1", name: "VPS", host: "x.com", enabled: true });
  });
});

describe("passphraseAccount", () => {
  it("deriva do id, não do nome — renomear não órfã o segredo no keyring", () => {
    expect(passphraseAccount("s1")).toBe("server:s1:passphrase");
    expect(passphraseAccount("s1")).toBe(passphraseAccount("s1"));
  });
});

describe("remoteCommand", () => {
  it("só devolve comando para ação do enum fechado", () => {
    expect(remoteCommand("status")).toBe("docker compose ps");
    expect(remoteCommand("up")).toContain("up -d");
    // @ts-expect-error — string livre não é ação válida
    expect(remoteCommand("rm -rf /")).toBeUndefined();
  });
});

describe("needsConfirmation", () => {
  const server = (environment: DeployServer["environment"]): DeployServer =>
    ({ ...emptyDraft(), id: "s1", createdAt: "", enabled: true, environment }) as DeployServer;

  it("produção confirma o que muda o serviço", () => {
    expect(needsConfirmation(server("prod"), "up")).toBe(true);
    expect(needsConfirmation(server("prod"), "restart")).toBe(true);
  });

  it("leitura nunca confirma, em nenhum ambiente", () => {
    expect(needsConfirmation(server("prod"), "status")).toBe(false);
    expect(needsConfirmation(server("prod"), "logs")).toBe(false);
  });

  it("fora de produção não interrompe o fluxo", () => {
    expect(needsConfirmation(server("dev"), "up")).toBe(false);
  });
});
