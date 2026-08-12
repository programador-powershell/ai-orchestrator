import { describe, expect, it } from "vitest";
import { artifactRunHint, parseGithub, resolveSource, sourceLabel, validateArtifact, validateFolder } from "./source";

const ok = (result: ReturnType<typeof resolveSource>) => {
  if (!result.ok) throw new Error(`esperava sucesso, veio: ${result.reason}`);
  return result.source;
};

describe("parseGithub", () => {
  it("aceita URL, SSH e o atalho owner/repo — sempre normalizando para HTTPS", () => {
    for (const input of ["https://github.com/vercel/next.js", "git@github.com:vercel/next.js.git", "vercel/next.js"]) {
      const source = ok(parseGithub(input));
      expect(source).toMatchObject({ kind: "github", owner: "vercel", repo: "next.js" });
      expect((source as { cloneUrl: string }).cloneUrl).toBe("https://github.com/vercel/next.js.git");
    }
  });

  it("extrai o branch da URL /tree/", () => {
    expect(ok(parseGithub("https://github.com/acme/api/tree/develop"))).toMatchObject({ ref: "develop" });
  });

  it("recusa host que não seja GitHub", () => {
    const result = parseGithub("https://gitlab.com/acme/api");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain("GitHub");
  });

  it("recusa lixo", () => {
    expect(parseGithub("").ok).toBe(false);
    expect(parseGithub("apenas-um-nome").ok).toBe(false);
  });
});

describe("validateFolder", () => {
  it("aceita uma pasta de projeto comum", () => {
    expect(ok(validateFolder("C:\\Users\\daniel\\Code\\api"))).toMatchObject({ kind: "folder" });
    expect(ok(validateFolder("/home/daniel/code/api")).kind).toBe("folder");
  });

  it("recusa pastas com credenciais, mesmo se o usuário insistir", () => {
    for (const path of ["C:\\Users\\daniel\\.ssh", "/home/daniel/.aws/config", "C:\\Users\\d\\.gnupg"]) {
      const result = validateFolder(path);
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.reason).toContain("protegida");
    }
  });

  it("recusa diretórios do sistema", () => {
    expect(validateFolder("C:\\Windows\\System32").ok).toBe(false);
    expect(validateFolder("/etc/nginx").ok).toBe(false);
    expect(validateFolder("C:\\Program Files\\App").ok).toBe(false);
  });

  it("recusa escopo amplo demais (raiz do disco ou do perfil)", () => {
    for (const path of ["C:\\", "/", "C:\\Users\\daniel", "/home/daniel"]) {
      const result = validateFolder(path);
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.reason).toContain("amplo");
    }
  });

  it("recusa vazio", () => {
    expect(validateFolder("   ").ok).toBe(false);
  });
});

describe("validateArtifact", () => {
  it("identifica o formato pela extensão", () => {
    expect(ok(validateArtifact("C:\\dist\\app.zip"))).toMatchObject({ format: "zip" });
    expect(ok(validateArtifact("/tmp/build.tar.gz"))).toMatchObject({ format: "tar" });
    expect(ok(validateArtifact("/opt/api.jar"))).toMatchObject({ format: "jar" });
    expect(ok(validateArtifact("/opt/site.war"))).toMatchObject({ format: "war" });
  });

  it("recusa pasta em vez de arquivo", () => {
    expect(validateArtifact("C:\\dist\\").ok).toBe(false);
  });

  it("recusa caminho protegido", () => {
    expect(validateArtifact("C:\\Users\\d\\.ssh\\id_rsa").ok).toBe(false);
  });
});

describe("sourceLabel", () => {
  it("resume cada fonte para o cabeçalho", () => {
    expect(sourceLabel(ok(parseGithub("acme/api")))).toBe("acme/api");
    expect(sourceLabel(ok(parseGithub("https://github.com/acme/api/tree/main")))).toBe("acme/api@main");
    expect(sourceLabel(ok(validateFolder("C:\\Code\\meu-projeto")))).toBe("meu-projeto");
    expect(sourceLabel(ok(validateArtifact("/dist/app.zip")))).toBe("app.zip");
  });
});

describe("artifactRunHint", () => {
  it("sugere como rodar o que já vem compilado", () => {
    expect(artifactRunHint({ kind: "artifact", path: "a.jar", format: "jar" })).toContain("java -jar");
    expect(artifactRunHint({ kind: "artifact", path: "a.war", format: "war" })).toContain("Tomcat");
    expect(artifactRunHint({ kind: "artifact", path: "a.zip", format: "zip" })).toBeUndefined();
  });
});

describe("resolveSource", () => {
  it("despacha para o validador certo", () => {
    expect(resolveSource("github", "acme/api").ok).toBe(true);
    expect(resolveSource("folder", "/home/d/code/api").ok).toBe(true);
    expect(resolveSource("artifact", "/dist/a.zip").ok).toBe(true);
    expect(resolveSource("github", "/home/d/code").ok).toBe(false);
  });
});
