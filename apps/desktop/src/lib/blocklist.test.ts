import { describe, expect, it } from "vitest";
import { blockedBy, blockedMessage, blockedUrl, matchesDomain } from "./blocklist";

/**
 * Os mesmos casos existem em `src-tauri/src/blocklist.rs`. Se um lado mudar
 * sem o outro, um dos dois passa a bloquear coisa diferente — e a divergência
 * seria invisível até alguém alcançar um domínio que devia estar barrado.
 */
describe("matchesDomain", () => {
  it("pega o domínio exato e os subdomínios", () => {
    expect(matchesDomain("exemplo.com", "exemplo.com")).toBe(true);
    expect(matchesDomain("exemplo.com", "www.exemplo.com")).toBe(true);
    expect(matchesDomain("exemplo.com", "a.b.exemplo.com")).toBe(true);
  });

  /** A armadilha: `endsWith` casaria, e o domínio se registra de graça. */
  it("NÃO pega domínio que apenas termina igual", () => {
    expect(matchesDomain("exemplo.com", "malexemplo.com")).toBe(false);
    expect(matchesDomain("openai.com", "notopenai.com")).toBe(false);
  });

  it("curinga pega só os subdomínios", () => {
    expect(matchesDomain("*.exemplo.com", "api.exemplo.com")).toBe(true);
    expect(matchesDomain("*.exemplo.com", "exemplo.com")).toBe(false);
    expect(matchesDomain("*.exemplo.com", "malexemplo.com")).toBe(false);
  });

  it("ignora caixa, ponto final e porta", () => {
    expect(matchesDomain("Exemplo.COM", "WWW.exemplo.com.")).toBe(true);
    expect(matchesDomain("exemplo.com:8080", "api.exemplo.com")).toBe(true);
  });

  it("IPv6 não é confundido com porta", () => {
    expect(matchesDomain("[::1]", "[::1]")).toBe(true);
  });

  it("regra ou host vazio não bloqueia", () => {
    expect(matchesDomain("", "exemplo.com")).toBe(false);
    expect(matchesDomain("exemplo.com", "")).toBe(false);
    expect(matchesDomain("   ", "exemplo.com")).toBe(false);
  });
});

describe("blockedBy", () => {
  const regras = ["facebook.com", "*.tiktok.com"];

  it("devolve a regra que pegou", () => {
    expect(blockedBy(regras, "www.facebook.com")).toBe("facebook.com");
    expect(blockedBy(regras, "cdn.tiktok.com")).toBe("*.tiktok.com");
  });

  it("host permitido devolve null", () => {
    expect(blockedBy(regras, "empresa.com.br")).toBeNull();
    expect(blockedBy(regras, "tiktok.com")).toBeNull(); // curinga não pega o apex
  });

  it("lista vazia não bloqueia nada", () => {
    expect(blockedBy([], "qualquer.com")).toBeNull();
  });
});

describe("blockedUrl", () => {
  const regras = ["facebook.com"];

  it("extrai o host da URL", () => {
    expect(blockedUrl(regras, "https://www.facebook.com/api?x=1")).toBe("facebook.com");
    expect(blockedUrl(regras, "https://empresa.com.br/x")).toBeNull();
  });

  /** Recusar URL inválida é de quem vai usá-la, com mensagem própria. */
  it("URL inválida não é tratada como bloqueada", () => {
    expect(blockedUrl(regras, "não é url")).toBeNull();
    expect(blockedUrl(regras, "")).toBeNull();
  });

  it("porta na URL não atrapalha", () => {
    expect(blockedUrl(regras, "https://api.facebook.com:8443/x")).toBe("facebook.com");
  });
});

describe("blockedMessage", () => {
  it("nomeia a regra — quem apanhar precisa saber o que pedir ao admin", () => {
    expect(blockedMessage("facebook.com")).toContain("facebook.com");
    expect(blockedMessage("facebook.com")).toContain("política da empresa");
  });
});
