import { describe, expect, it } from "vitest";
import {
  MAX_SESSION_LOGS,
  describeSession,
  emptySession,
  reduceSession,
  type PtyAction,
  type PtySession
} from "./ptySession";

const T = "2026-08-14T10:00:00.000Z";

function run(...acoes: PtyAction[]): PtySession {
  return acoes.reduce(reduceSession, emptySession());
}

const abrir: PtyAction = {
  type: "spawn:start",
  at: T,
  cwd: "C:/proj",
  target: "local",
  cols: 100,
  rows: 30
};
const pronto: PtyAction = { type: "spawn:ok", at: T, id: "s1" };

describe("reduceSession", () => {
  it("spawn:start reinicia o estado — reabrir não herda tráfego da anterior", () => {
    const usada = run(abrir, pronto, { type: "data", at: T, bytes: 500 });
    const nova = reduceSession(usada, abrir);
    expect(nova.bytesIn).toBe(0);
    expect(nova.id).toBe("");
    expect(nova.status).toBe("spawning");
    expect(nova.cols).toBe(100);
    expect(nova.logs).toHaveLength(1);
  });

  it("spawn:ok passa para running com o id", () => {
    const sessao = run(abrir, pronto);
    expect(sessao.status).toBe("running");
    expect(sessao.id).toBe("s1");
  });

  it("spawn:fail vira erro com a mensagem no log", () => {
    const sessao = run(abrir, { type: "spawn:fail", at: T, message: "SHELL_NOT_FOUND: nada" });
    expect(sessao.status).toBe("error");
    expect(sessao.logs.at(-1)?.message).toContain("SHELL_NOT_FOUND");
    expect(sessao.logs.at(-1)?.level).toBe("error");
  });

  it("conta tráfego nos dois sentidos e as operações", () => {
    const sessao = run(
      abrir,
      pronto,
      { type: "data", at: T, bytes: 120 },
      { type: "data", at: T, bytes: 80 },
      { type: "write", at: T, bytes: 3 },
      { type: "write", at: T, bytes: 1 },
      { type: "resize", at: T, cols: 120, rows: 40 }
    );
    expect(sessao.bytesIn).toBe(200);
    expect(sessao.bytesOut).toBe(4);
    expect(sessao.writeCount).toBe(2);
    expect(sessao.resizeCount).toBe(1);
    expect([sessao.cols, sessao.rows]).toEqual([120, 40]);
  });

  it("exit registra o CÓDIGO REAL e o motivo", () => {
    // É o ponto do conserto no Rust: antes exitCode era sempre null.
    const sessao = run(abrir, pronto, { type: "exit", at: T, exitCode: 1, reason: "exited" });
    expect(sessao.status).toBe("exited");
    expect(sessao.exitCode).toBe(1);
    expect(sessao.logs.at(-1)?.level).toBe("error");
    expect(sessao.logs.at(-1)?.message).toContain("exit 1");
  });

  it("exit 0 não é erro no log", () => {
    const sessao = run(abrir, pronto, { type: "exit", at: T, exitCode: 0, reason: "exited" });
    expect(sessao.logs.at(-1)?.level).toBe("info");
  });

  it("exit com reason killed vira killed, não exited", () => {
    const sessao = run(abrir, pronto, { type: "exit", at: T, exitCode: 1, reason: "killed" });
    expect(sessao.status).toBe("killed");
    // Encerramento pedido não é falha, mesmo com código diferente de zero.
    expect(sessao.logs.at(-1)?.level).toBe("info");
  });

  it("STATUS TERMINAL NÃO VOLTA ATRÁS", () => {
    // As threads de leitura e de espera são independentes no Rust: um
    // `pty-data` atrasado pode chegar depois do `pty-exit`. Se ele
    // ressuscitasse a sessão, a tela diria que há shell vivo onde não há e o
    // `pty_write` seguinte falharia sem explicação.
    const morta = run(abrir, pronto, { type: "exit", at: T, exitCode: 0, reason: "exited" });
    const depois = [
      { type: "data", at: T, bytes: 40 },
      { type: "write", at: T, bytes: 5 },
      { type: "resize", at: T, cols: 200, rows: 60 },
      { type: "exit", at: T, exitCode: 9, reason: "killed" }
    ].reduce(reduceSession, morta) as PtySession;

    expect(depois.status).toBe("exited");
    expect(depois.exitCode).toBe(0);
    // O byte chegou de fato, então é contado — o que não muda é o status.
    expect(depois.bytesIn).toBe(40);
    // Escrita e resize em sessão morta são descartados.
    expect(depois.bytesOut).toBe(0);
    expect(depois.resizeCount).toBe(0);
    expect(depois.cols).toBe(100);
  });

  it("erro de leitura NÃO encerra a sessão — quem encerra é o exit", () => {
    // O processo pode seguir vivo depois de um erro de leitura; declarar morto
    // aqui esconderia um shell que ainda responde.
    const sessao = run(abrir, pronto, {
      type: "error",
      at: T,
      code: "READ_ERROR",
      message: "pipe interrompido"
    });
    expect(sessao.status).toBe("running");
    expect(sessao.logs.at(-1)?.message).toContain("READ_ERROR");
  });

  it("o log tem teto e mantém os mais RECENTES", () => {
    let sessao = run(abrir, pronto);
    for (let i = 0; i < MAX_SESSION_LOGS + 30; i += 1) {
      sessao = reduceSession(sessao, { type: "error", at: T, code: "E", message: `n${i}` });
    }
    expect(sessao.logs).toHaveLength(MAX_SESSION_LOGS);
    expect(sessao.logs.at(-1)?.message).toContain(`n${MAX_SESSION_LOGS + 29}`);
  });

  it("não muta o estado recebido", () => {
    const antes = run(abrir, pronto);
    const copia = JSON.parse(JSON.stringify(antes));
    reduceSession(antes, { type: "data", at: T, bytes: 10 });
    expect(antes).toEqual(copia);
  });
});

describe("describeSession", () => {
  it("descreve cada estado de forma distinguível", () => {
    expect(describeSession(emptySession())).toBe("abrindo…");
    expect(describeSession(run(abrir, pronto))).toBe("local · 100×30");
    expect(describeSession(run(abrir, pronto, { type: "exit", at: T, exitCode: 2, reason: "exited" }))).toBe(
      "saiu (2)"
    );
    expect(describeSession(run(abrir, pronto, { type: "exit", at: T, reason: "killed" }))).toBe(
      "encerrado"
    );
    expect(describeSession(run(abrir, { type: "spawn:fail", at: T, message: "x" }))).toBe("erro");
  });

  it("mostra o destino remoto — a tela não pode dizer local e rodar em VPS", () => {
    const remota = run(
      { ...abrir, target: "deploy@vps.local" },
      pronto
    );
    expect(describeSession(remota)).toContain("deploy@vps.local");
  });
});
