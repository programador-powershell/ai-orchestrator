import { describe, expect, it, vi } from "vitest";
import { buildRun, bumpVersion, canRelease, planRelease, runPipeline, suggestBump, type Exec } from "./pipeline";
import { detectStacks } from "./stack";

const nodeStack = detectStacks({
  files: ["package.json"],
  manifests: { "package.json": JSON.stringify({ scripts: { build: "tsc", test: "vitest" } }) }
})[0];

const okExec: Exec = async () => ({ exitCode: 0, output: "pronto" });
const live = new AbortController().signal;

describe("buildRun", () => {
  it("materializa as etapas da stack como pendentes", () => {
    const run = buildRun("r1", nodeStack);
    expect(run.status).toBe("idle");
    expect(run.steps.map((step) => step.step)).toEqual(["Instalar dependências", "Build", "Testes"]);
    expect(run.steps.every((step) => step.status === "pending")).toBe(true);
  });
});

describe("runPipeline", () => {
  it("roda tudo em ordem quando passa", async () => {
    const seen: string[] = [];
    const exec: Exec = async (command) => {
      seen.push(command);
      return { exitCode: 0, output: "" };
    };
    const result = await runPipeline(buildRun("r1", nodeStack), exec, live);
    expect(seen).toEqual(["npm install", "npm run build", "npm test"]);
    expect(result.status).toBe("ok");
  });

  it("para no primeiro erro e marca as seguintes como puladas", async () => {
    const exec: Exec = async (command) => (command === "npm run build" ? { exitCode: 1, output: "erro TS" } : { exitCode: 0, output: "" });
    const result = await runPipeline(buildRun("r1", nodeStack), exec, live);

    expect(result.status).toBe("failed");
    expect(result.steps.map((step) => step.status)).toEqual(["ok", "failed", "skipped"]);
    expect(result.steps[1].output).toBe("erro TS");
    expect(result.steps[1].exitCode).toBe(1);
  });

  it("exceção do executor vira falha, não derruba o run", async () => {
    const exec: Exec = async () => {
      throw new Error("comando não encontrado");
    };
    const result = await runPipeline(buildRun("r1", nodeStack), exec, live);
    expect(result.status).toBe("failed");
    expect(result.steps[0].output).toBe("comando não encontrado");
  });

  it("cancelar no meio não marca as etapas restantes como erro", async () => {
    const controller = new AbortController();
    const exec: Exec = async (command) => {
      if (command === "npm install") controller.abort();
      return { exitCode: 0, output: "" };
    };
    const result = await runPipeline(buildRun("r1", nodeStack), exec, controller.signal);
    expect(result.status).toBe("cancelled");
    expect(result.steps.map((step) => step.status)).toEqual(["ok", "cancelled", "skipped"]);
  });

  it("emite onStep em cada transição, para a UI acompanhar ao vivo", async () => {
    const onStep = vi.fn();
    await runPipeline(buildRun("r1", nodeStack), okExec, live, { onStep });
    // 3 etapas × (running + terminal)
    expect(onStep).toHaveBeenCalledTimes(6);
    expect(onStep.mock.calls[0][0].status).toBe("running");
    expect(onStep.mock.calls[1][0].status).toBe("ok");
  });

  it("mede a duração de cada etapa", async () => {
    let clock = 0;
    const result = await runPipeline(buildRun("r1", nodeStack), okExec, live, {}, () => (clock += 100));
    expect(result.steps[0].durationMs).toBe(100);
  });

  it("não muta o run original", async () => {
    const run = buildRun("r1", nodeStack);
    await runPipeline(run, okExec, live);
    expect(run.steps.every((step) => step.status === "pending")).toBe(true);
  });
});

describe("bumpVersion", () => {
  it("segue o padrão V.x / V.x.y / V.x.y.z", () => {
    expect(bumpVersion("V.1", "major")).toBe("V.2");
    expect(bumpVersion("V.1", "minor")).toBe("V.1.1");
    expect(bumpVersion("V.1.1", "minor")).toBe("V.1.2");
    expect(bumpVersion("V.1.1", "patch")).toBe("V.1.1.1");
    expect(bumpVersion("V.1.1.1", "patch")).toBe("V.1.1.2");
    expect(bumpVersion("V.2.3.4", "major")).toBe("V.3");
  });

  it("minor zera nada além do próprio nível", () => {
    expect(bumpVersion("V.1.2.5", "minor")).toBe("V.1.3");
  });

  it("versão ausente ou inválida começa do zero sem quebrar", () => {
    expect(bumpVersion("", "major")).toBe("V.1");
    expect(bumpVersion("qualquer coisa", "minor")).toBe("V.1.1");
    expect(bumpVersion("1.2.3", "patch")).toBe("V.1.0.1");
  });
});

describe("planRelease", () => {
  it("monta tag anotada e push opcional", () => {
    expect(planRelease("V.1.1", "build ok", false).commands).toEqual(['git tag -a V.1.1 -m "build ok"']);
    expect(planRelease("V.1.1", "build ok", true).commands).toHaveLength(2);
  });

  it("neutraliza aspas na mensagem (não deixa escapar do comando)", () => {
    expect(planRelease("V.1", 'quebrou o "build"', false).commands[0]).toBe(`git tag -a V.1 -m "quebrou o 'build'"`);
  });

  it("trunca mensagem gigante", () => {
    expect(planRelease("V.1", "x".repeat(500), false).commands[0].length).toBeLessThan(240);
  });
});

describe("canRelease", () => {
  it("só libera release quando o run inteiro passou", async () => {
    expect(canRelease(await runPipeline(buildRun("r1", nodeStack), okExec, live))).toBe(true);

    const falho = await runPipeline(buildRun("r2", nodeStack), async () => ({ exitCode: 1, output: "" }), live);
    expect(canRelease(falho)).toBe(false);
    expect(canRelease(buildRun("r3", nodeStack))).toBe(false);
  });

  it("run sem etapas não vira release", () => {
    expect(canRelease({ id: "r", status: "ok", steps: [] })).toBe(false);
  });
});

describe("suggestBump", () => {
  it("empacotou → ganho de função; só build/teste → correção", async () => {
    const rust = detectStacks({ files: ["Cargo.toml"] })[0];
    const comPacote = await runPipeline(buildRun("r1", rust), okExec, live);
    expect(suggestBump(comPacote.steps)).toBe("minor");

    const semPacote = await runPipeline(buildRun("r2", nodeStack), okExec, live);
    expect(suggestBump(semPacote.steps)).toBe("patch");
  });
});
