import { beforeEach, describe, expect, it, vi } from "vitest";
import { recordAgentAction, redactCommand, REDACTED } from "./agentAudit";
import type { GatewaySession } from "./gateway";

const sessao: GatewaySession = {
  baseUrl: "https://gw.exemplo.com/",
  accessToken: "token-de-sessao",
  workspaceId: "ws-1"
} as GatewaySession;

const acao = {
  agent: "Coletar dados",
  goal: "montar o relatório",
  command: "python script.py",
  approved: true,
  exitCode: 0,
  durationMs: 120.6,
  jailed: true
};

describe("redactCommand", () => {
  /**
   * O comando É o registro de auditoria — mas pode carregar credencial, e a
   * política proíbe persistir segredo. A forma fica, o valor sai.
   */
  it("redige Bearer preservando o resto do comando", () => {
    const out = redactCommand('curl -H "Authorization: Bearer abcdef1234567890abcdef" https://api.x/y');
    expect(out).toContain("curl -H");
    expect(out).toContain("https://api.x/y");
    expect(out).toContain(REDACTED);
    expect(out).not.toContain("abcdef1234567890abcdef");
  });

  it("redige senha e chave em variável de ambiente ou flag", () => {
    for (const [entrada, segredo] of [
      ["PGPASSWORD=s3nh4Secreta psql -h db", "s3nh4Secreta"],
      ['export API_KEY="minha-chave-secreta"', "minha-chave-secreta"],
      ["deploy --token ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
      ["cli --password hunter22", "hunter22"]
    ] as const) {
      const out = redactCommand(entrada);
      expect(out, entrada).toContain(REDACTED);
      expect(out, entrada).not.toContain(segredo);
    }
  });

  it("redige chaves com forma própria", () => {
    for (const segredo of [
      "AKIAIOSFODNN7EXAMPLE",
      "ghp_1234567890abcdefghijklmnopqrstuvwx",
      "sk-abcdefghijklmnopqrstuvwx",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcd"
    ]) {
      expect(redactCommand(`echo ${segredo}`)).not.toContain(segredo);
    }
  });

  it("redige a senha da URL de conexão sem perder o host", () => {
    const out = redactCommand("psql postgres://user:s3cr3t@db.interno:5432/base");
    expect(out).toContain("db.interno:5432/base");
    expect(out).toContain("postgres://user:");
    expect(out).not.toContain("s3cr3t");
  });

  it("comando sem segredo sai intacto", () => {
    const limpo = "python script.py --input dados.csv --output saida.json";
    expect(redactCommand(limpo)).toBe(limpo);
  });

  it("comando gigante é truncado com marca visível", () => {
    const out = redactCommand("x".repeat(5000));
    expect(out.length).toBeLessThan(2100);
    expect(out).toContain("(truncado)");
  });

  /**
   * Limite honesto: a redação cobre padrões CONHECIDOS. Este teste existe para
   * o limite ficar documentado, não para celebrá-lo.
   */
  it("segredo em formato desconhecido NÃO é redigido — limite declarado", () => {
    const exotico = "meu-token-interno-XPTO-42";
    expect(redactCommand(`app --credencial ${exotico}`)).toContain(exotico);
  });
});

describe("recordAgentAction", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("envia para o endpoint do workspace com o token da sessão", async () => {
    fetchMock.mockResolvedValue({ ok: true });
    const outcome = await recordAgentAction(sessao, acao);
    expect(outcome.recorded).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://gw.exemplo.com/v1/workspaces/ws-1/agent-actions");
    expect(init.headers.Authorization).toBe("Bearer token-de-sessao");
    const corpo = JSON.parse(init.body);
    expect(corpo).toMatchObject({ agent: "Coletar dados", approved: true, exitCode: 0, jailed: true });
    // duração é arredondada — a trilha não precisa de fração de milissegundo
    expect(corpo.durationMs).toBe(121);
  });

  /** O segredo não pode nem TRAFEGAR: a redação é no cliente. */
  it("o comando sai redigido no corpo da requisição", async () => {
    fetchMock.mockResolvedValue({ ok: true });
    await recordAgentAction(sessao, { ...acao, command: "curl -H 'Authorization: Bearer supersecreto1234567890'" });
    const corpo = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(corpo.command).toContain(REDACTED);
    expect(fetchMock.mock.calls[0][1].body).not.toContain("supersecreto1234567890");
  });

  it("sem sessão não tenta enviar e diz o motivo", async () => {
    const outcome = await recordAgentAction(null, acao);
    expect(outcome.recorded).toBe(false);
    expect(outcome.reason).toContain("não auditada");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resposta de erro do gateway não lança — devolve o motivo", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403 });
    const outcome = await recordAgentAction(sessao, acao);
    expect(outcome.recorded).toBe(false);
    expect(outcome.reason).toContain("403");
  });

  it("rede caída não lança — devolve o motivo", async () => {
    fetchMock.mockImplementation(() => Promise.reject(new Error("offline")));
    const outcome = await recordAgentAction(sessao, acao);
    expect(outcome.recorded).toBe(false);
    expect(outcome.reason).toContain("offline");
  });

  it("recusa registrada também é auditada — negar é informação", async () => {
    fetchMock.mockResolvedValue({ ok: true });
    await recordAgentAction(sessao, { ...acao, approved: false, exitCode: null });
    const corpo = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(corpo.approved).toBe(false);
    expect(corpo.exitCode).toBeNull();
  });
});
