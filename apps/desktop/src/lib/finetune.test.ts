import { describe, expect, it, vi } from "vitest";

vi.stubGlobal("window", {});
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const { validateJsonlForFineTune, buildJobPayload, normalizeJob, FINETUNABLE_MODELS } = await import("./finetune");

const validLine = (index: number) =>
  JSON.stringify({
    messages: [
      { role: "user", content: `pergunta ${index}` },
      { role: "assistant", content: `resposta ${index}` }
    ]
  });

describe("validateJsonlForFineTune", () => {
  it("aceita dataset com 10+ exemplos válidos", () => {
    const jsonl = Array.from({ length: 10 }, (_, index) => validLine(index)).join("\n");
    const result = validateJsonlForFineTune(jsonl);
    expect(result.ok).toBe(true);
    expect(result.examples).toBe(10);
    expect(result.issues).toHaveLength(0);
  });

  it("aponta o mínimo de 10 exemplos da API", () => {
    const jsonl = Array.from({ length: 3 }, (_, index) => validLine(index)).join("\n");
    const result = validateJsonlForFineTune(jsonl);
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.includes("mínimo 10"))).toBe(true);
  });

  it("aponta linha malformada e linha sem assistant, com número da linha", () => {
    const jsonl = [validLine(1), "{nao é json", JSON.stringify({ messages: [{ role: "user", content: "só pergunta" }] })].join("\n");
    const result = validateJsonlForFineTune(jsonl);
    expect(result.issues.some((issue) => issue.startsWith("linha 2:"))).toBe(true);
    expect(result.issues.some((issue) => issue.startsWith("linha 3:"))).toBe(true);
  });
});

describe("buildJobPayload", () => {
  it("monta o payload da API com suffix truncado em 18 chars", () => {
    const payload = buildJobPayload("file-abc", "gpt-4.1-mini", "meu-modelo-com-nome-muito-longo");
    expect(payload).toEqual({
      training_file: "file-abc",
      model: "gpt-4.1-mini",
      suffix: "meu-modelo-com-nom"
    });
  });

  it("omite suffix vazio", () => {
    expect(buildJobPayload("file-x", "gpt-4o-mini")).toEqual({ training_file: "file-x", model: "gpt-4o-mini" });
  });

  it("monta method supervised com hiperparâmetros quando há opções", () => {
    const payload = buildJobPayload("file-a", "gpt-4o-mini", undefined, {
      epochs: 3,
      batchSize: 4,
      lrMultiplier: 2
    });
    expect(payload).toEqual({
      training_file: "file-a",
      model: "gpt-4o-mini",
      method: {
        type: "supervised",
        supervised: { hyperparameters: { n_epochs: 3, batch_size: 4, learning_rate_multiplier: 2 } }
      }
    });
  });

  it("monta method dpo com validation_file e omite hiperparâmetro ausente", () => {
    const payload = buildJobPayload("file-b", "gpt-4o-mini", "pref", {
      method: "dpo",
      epochs: 1,
      validationFileId: "file-val"
    });
    expect(payload).toEqual({
      training_file: "file-b",
      model: "gpt-4o-mini",
      suffix: "pref",
      validation_file: "file-val",
      method: { type: "dpo", dpo: { hyperparameters: { n_epochs: 1 } } }
    });
  });
});

describe("normalizeJob", () => {
  it("normaliza o job da API (sucesso e erro)", () => {
    expect(
      normalizeJob({ id: "ftjob-1", status: "succeeded", fine_tuned_model: "ft:gpt-4.1-mini:org:x:abc" })
    ).toEqual({ id: "ftjob-1", status: "succeeded", fineTunedModel: "ft:gpt-4.1-mini:org:x:abc", error: null });
    expect(normalizeJob({ id: "ftjob-2", status: "failed", error: { message: "dataset inválido" } }).error).toBe(
      "dataset inválido"
    );
  });
});

describe("catálogo de modelos fine-tunáveis", () => {
  it("inclui os modelos conhecidos da OpenAI", () => {
    expect(FINETUNABLE_MODELS).toContain("gpt-4.1-mini");
  });
});
