import { describe, expect, it } from "vitest";
import {
  LOCK_TIMEOUT_MS,
  TOKEN_LIFETIME_MS,
  acquireLock,
  buildEditorUrl,
  canPutFile,
  fillUrlsrc,
  findAction,
  isLockValid,
  isTokenExpired,
  isValidLockId,
  isValidWopiPath,
  parseDiscovery,
  releaseLock,
  requiresExtendedLockLength,
  tokenExpiry,
  wopiSrc,
  type LockState
} from "./wopi";

const DISCOVERY = `<?xml version="1.0"?>
<wopi-discovery>
  <net-zone name="external-http">
    <app name="Word">
      <action name="edit" ext="docx" urlsrc="https://office.local/browser/word?WOPISrc=&lt;WOPI_SOURCE=value&amp;&gt;&lt;ui=UI_LLCC&amp;&gt;" />
      <action name="view" ext="docx" urlsrc="https://office.local/browser/word/view?" />
    </app>
    <app name="Excel">
      <action name="edit" ext="xlsx" urlsrc="https://office.local/browser/calc?" />
    </app>
  </net-zone>
</wopi-discovery>`;

describe("parseDiscovery", () => {
  it("extrai as ações por extensão", () => {
    const actions = parseDiscovery(DISCOVERY);
    expect(actions).toHaveLength(3);
    expect(findAction(actions, "docx", "edit")?.urlsrc).toContain("word?");
    expect(findAction(actions, "xlsx", "edit")?.urlsrc).toContain("calc");
  });

  it("aceita a extensão com ponto e em maiúscula", () => {
    const actions = parseDiscovery(DISCOVERY);
    expect(findAction(actions, ".DOCX", "edit")).toBeDefined();
  });

  it("XML inválido não derruba — devolve vazio", () => {
    expect(parseDiscovery("<não é xml")).toEqual([]);
    expect(parseDiscovery("")).toEqual([]);
  });

  it("ignora action sem os atributos obrigatórios", () => {
    expect(parseDiscovery(`<x><action name="edit" /></x>`)).toEqual([]);
  });
});

describe("fillUrlsrc", () => {
  it("substitui pelo TOKEN e preserva o nome do parametro", () => {
    // <ui=UI_LLCC&> -> ui=pt-BR&  (o token e o lado DIREITO)
    expect(fillUrlsrc("http://e/?<ui=UI_LLCC&>x=1", { UI_LLCC: "pt-BR" })).toBe("http://e/?ui=pt-BR&x=1");
  });

  it("REMOVE inteiro o token desconhecido — sinais e & inclusive", () => {
    expect(fillUrlsrc("http://e/?<novo=TOKEN_NOVO&><ui=UI_LLCC&>", { UI_LLCC: "pt-BR" })).toBe("http://e/?ui=pt-BR&");
  });

  it("valor vazio tambem remove o placeholder", () => {
    expect(fillUrlsrc("http://e/?<hs=HOST_SESSION_ID&>", { HOST_SESSION_ID: "" })).toBe("http://e/?");
  });

  it("placeholder sem & nao inventa separador", () => {
    expect(fillUrlsrc("http://e/?<ui=UI_LLCC>", { UI_LLCC: "pt-BR" })).toBe("http://e/?ui=pt-BR");
  });

  it("urlsrc sem placeholder nenhum passa intacto", () => {
    expect(fillUrlsrc("http://e/browser/calc?", {})).toBe("http://e/browser/calc?");
  });

  it("escapa o valor", () => {
    expect(fillUrlsrc("http://e/?<ui=UI_LLCC&>", { UI_LLCC: "a b&c" })).toBe("http://e/?ui=a%20b%26c&");
  });
});

describe("buildEditorUrl", () => {
  it("acrescenta o WOPISrc e resolve os placeholders conhecidos", () => {
    const url = buildEditorUrl({
      urlsrc: "http://e/?<ui=UI_LLCC&><novo=DESCONHECIDO&>",
      wopiSrc: "http://127.0.0.1:9000/wopi/files/abc"
    });
    expect(url).toBe("http://e/?ui=pt-BR&WOPISrc=" + encodeURIComponent("http://127.0.0.1:9000/wopi/files/abc"));
    expect(url).not.toContain("<");
    expect(url).not.toContain("DESCONHECIDO");
  });

  it("nao duplica separador quando o urlsrc ja termina em ? ou &", () => {
    expect(buildEditorUrl({ urlsrc: "http://e/calc?", wopiSrc: "s" })).toBe("http://e/calc?WOPISrc=s");
    expect(buildEditorUrl({ urlsrc: "http://e/calc", wopiSrc: "s" })).toBe("http://e/calc?WOPISrc=s");
  });

  it("o token NUNCA entra na URL do iframe — vai no POST form da host page", () => {
    const url = buildEditorUrl({ urlsrc: "http://e/?", wopiSrc: "http://h/wopi/files/1" });
    expect(url).not.toContain("access_token");
  });
});

describe("tokenExpiry", () => {
  it("devolve o INSTANTE de expiração, não a duração", () => {
    const now = 1_800_000_000_000;
    expect(tokenExpiry(now)).toBe(now + TOKEN_LIFETIME_MS);
    // O bug clássico seria devolver TOKEN_LIFETIME_MS puro.
    expect(tokenExpiry(now)).not.toBe(TOKEN_LIFETIME_MS);
  });

  it("nunca devolve 0 — 0 desliga o aviso de sessão expirando", () => {
    expect(tokenExpiry(0, 0)).toBeGreaterThan(0);
  });

  it("compara expiração contra o agora", () => {
    const now = 1_000_000;
    expect(isTokenExpired(tokenExpiry(now), now)).toBe(false);
    expect(isTokenExpired(now - 1, now)).toBe(true);
    expect(isTokenExpired(now, now)).toBe(true);
  });
});

describe("locks", () => {
  const lock = (id: string, at: number): LockState => ({ id, acquiredAt: at, refreshedAt: at });

  it("o host expira o lock sozinho em 30 min — o editor pode morrer sem soltar", () => {
    const held = lock("L1", 0);
    expect(isLockValid(held, LOCK_TIMEOUT_MS - 1)).toBe(true);
    expect(isLockValid(held, LOCK_TIMEOUT_MS)).toBe(false);
    expect(isLockValid(undefined, 0)).toBe(false);
  });

  it("trava arquivo livre", () => {
    const result = acquireLock(undefined, "L1", 100);
    expect(result.ok && result.lock.id).toBe("L1");
  });

  it("o mesmo lock renova em vez de conflitar", () => {
    const result = acquireLock(lock("L1", 0), "L1", 500);
    expect(result.ok && result.lock.refreshedAt).toBe(500);
  });

  it("lock diferente devolve 409 COM o lock atual — omitir isso trava o editor", () => {
    const result = acquireLock(lock("L1", 0), "L2", 500);
    expect(result).toEqual({ ok: false, status: 409, currentLock: "L1" });
  });

  it("lock expirado é tomado por outro sem conflito", () => {
    const result = acquireLock(lock("L1", 0), "L2", LOCK_TIMEOUT_MS + 1);
    expect(result.ok && result.lock.id).toBe("L2");
  });

  it("destravar não exige ser o mesmo usuário, só apresentar o lock certo", () => {
    expect(releaseLock(lock("L1", 0), "L1", 10).ok).toBe(true);
    expect(releaseLock(lock("L1", 0), "L2", 10)).toEqual({ ok: false, status: 409, currentLock: "L1" });
  });

  it("arquivo destravado devolve lock atual VAZIO, não undefined", () => {
    expect(releaseLock(undefined, "L1", 10)).toEqual({ ok: false, status: 409, currentLock: "" });
  });

  it("valida o id do lock: ASCII, não vazio, dentro do teto", () => {
    expect(isValidLockId("abc-123")).toBe(true);
    expect(isValidLockId("")).toBe(false);
    expect(isValidLockId("x".repeat(1025))).toBe(false);
    expect(isValidLockId("acentuação")).toBe(false);
  });

  it("acima de 256 chars exige SupportsExtendedLockLength", () => {
    expect(requiresExtendedLockLength("x".repeat(256))).toBe(false);
    expect(requiresExtendedLockLength("x".repeat(257))).toBe(true);
  });
});

describe("canPutFile", () => {
  const held: LockState = { id: "L1", acquiredAt: 0, refreshedAt: 0 };

  it("com o lock certo, grava", () => {
    expect(canPutFile(held, "L1", 1000, 10)).toEqual({ ok: true });
  });

  it("com lock diferente, 409 com o lock atual", () => {
    expect(canPutFile(held, "L2", 1000, 10)).toEqual({ ok: false, status: 409, currentLock: "L1" });
  });

  it("SEM lock só grava se o arquivo tiver 0 bytes", () => {
    expect(canPutFile(undefined, "L1", 0, 10)).toEqual({ ok: true });
    expect(canPutFile(undefined, "L1", 1, 10)).toEqual({ ok: false, status: 409, currentLock: "" });
  });
});

describe("isValidWopiPath", () => {
  it("exige o prefixo /wopi e proíbe /ids no caminho", () => {
    expect(isValidWopiPath("/wopi/files/abc")).toBe(true);
    expect(isValidWopiPath("/wopi/files/abc/contents")).toBe(true);
    expect(isValidWopiPath("/api/wopi/files/abc")).toBe(false);
    expect(isValidWopiPath("/wopi/ids/abc")).toBe(false);
  });
});

describe("wopiSrc", () => {
  it("monta a URL do nosso endpoint, sem barra dupla e com o id escapado", () => {
    expect(wopiSrc("http://127.0.0.1:9000/", "a b")).toBe("http://127.0.0.1:9000/wopi/files/a%20b");
  });

  it("o WOPISrc não carrega token", () => {
    expect(wopiSrc("http://h", "1")).not.toContain("token");
  });
});
