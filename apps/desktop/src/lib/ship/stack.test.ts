import { describe, expect, it } from "vitest";
import { detectStacks, pipelineFor } from "./stack";

const detect = (files: string[], manifests?: Record<string, string>) => detectStacks({ files, manifests });

describe("detectStacks", () => {
  it("Node: identifica o gerenciador pelo lockfile", () => {
    expect(detect(["package.json", "pnpm-lock.yaml"])[0].variant).toBe("pnpm");
    expect(detect(["package.json", "yarn.lock"])[0].variant).toBe("yarn");
    expect(detect(["package.json", "bun.lockb"])[0].variant).toBe("bun");
    expect(detect(["package.json"])[0].variant).toBe("npm");
  });

  it("Node: só oferece comandos que EXISTEM no package.json", () => {
    const semScripts = detect(["package.json", "pnpm-lock.yaml"], { "package.json": "{}" })[0];
    expect(semScripts.commands.install).toBe("pnpm install");
    expect(semScripts.commands.build).toBeUndefined();

    const comScripts = detect(["package.json"], {
      "package.json": JSON.stringify({ scripts: { build: "tsc", test: "vitest", dev: "next dev" } })
    })[0];
    expect(comScripts.commands.build).toBe("npm run build");
    expect(comScripts.commands.test).toBe("npm test");
    expect(comScripts.commands.run).toBe("npm run dev");
  });

  it("Python: distingue poetry de pip", () => {
    const poetry = detect(["pyproject.toml"], { "pyproject.toml": "[tool.poetry]\nname='x'" })[0];
    expect(poetry.variant).toBe("poetry");
    expect(poetry.commands.install).toBe("poetry install");

    const pip = detect(["requirements.txt"])[0];
    expect(pip.variant).toBe("pip");
    expect(pip.commands.install).toContain("requirements.txt");
  });

  it("identifica Go, Rust, PHP, Ruby", () => {
    expect(detect(["go.mod"])[0].id).toBe("go");
    expect(detect(["Cargo.toml"])[0].id).toBe("rust");
    expect(detect(["composer.json"])[0].id).toBe("php");
    expect(detect(["Gemfile"])[0].id).toBe("ruby");
  });

  it("Java: maven e gradle têm comandos diferentes", () => {
    expect(detect(["pom.xml"])[0].commands.build).toContain("mvn");
    expect(detect(["build.gradle"])[0].commands.build).toContain("gradlew");
  });

  it(".NET: detecta pelo csproj/sln em qualquer subpasta", () => {
    const dotnet = detect(["src/Api/Api.csproj"])[0];
    expect(dotnet.id).toBe("dotnet");
    expect(dotnet.commands.package).toContain("publish");
  });

  it("Docker: compose muda os comandos", () => {
    expect(detect(["Dockerfile"])[0].commands.run).toContain("docker run");
    expect(detect(["docker-compose.yml"])[0].commands.run).toContain("compose up");
  });

  it("projeto multi-stack lista todas, mais confiável primeiro", () => {
    const stacks = detect(["package.json", "Dockerfile"]);
    expect(stacks.map((stack) => stack.id)).toEqual(["node", "docker"]);
  });

  it("site estático só conta quando não há stack real", () => {
    expect(detect(["index.html"])[0].id).toBe("static");
    expect(detect(["index.html", "package.json"]).map((s) => s.id)).not.toContain("static");
  });

  it("pasta sem âncora devolve desconhecida (não chuta)", () => {
    const unknown = detect(["README.md", "notas.txt"])[0];
    expect(unknown.id).toBe("unknown");
    expect(unknown.confidence).toBe(0);
  });

  it("evidência sempre aponta o arquivo que provou a detecção", () => {
    expect(detect(["go.mod"])[0].evidence).toBe("go.mod");
    expect(detect(["src/Api/Api.csproj"])[0].evidence).toBe("Api.csproj");
  });
});

describe("pipelineFor", () => {
  it("monta as etapas na ordem, pulando as que a stack não tem", () => {
    const rust = detect(["Cargo.toml"])[0];
    expect(pipelineFor(rust).map((step) => step.step)).toEqual(["Build", "Testes", "Empacotar"]);
  });

  it("stack sem comandos gera pipeline vazio", () => {
    expect(pipelineFor(detect(["index.html"])[0])).toEqual([]);
  });

  it("Node com scripts completos vira instalar → build → testes", () => {
    const node = detect(["package.json"], {
      "package.json": JSON.stringify({ scripts: { build: "tsc", test: "vitest" } })
    })[0];
    expect(pipelineFor(node).map((step) => step.command)).toEqual(["npm install", "npm run build", "npm test"]);
  });
});
