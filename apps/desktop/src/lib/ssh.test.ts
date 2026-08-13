import { describe, expect, it } from "vitest";

import type { DeployServer } from "./ship/server";
import { asTerminalResult, resolveRoute, routeLabel, toTarget } from "./ssh";

const servidor = (over: Partial<DeployServer> = {}): DeployServer => ({
  id: "s1",
  name: "Openship",
  host: "vps.multiplike.local",
  port: 22,
  user: "deploy",
  authMethod: "agent",
  network: "vpn",
  environment: "prod",
  remoteWorkdir: "/srv/app",
  dockerSocket: "/var/run/docker.sock",
  enabled: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  ...over
});

describe("resolveRoute", () => {
  it("ambiente local roda na estação", () => {
    expect(resolveRoute("local", [servidor()])).toEqual({ kind: "local" });
  });

  it("WSL e nuvem ainda não têm rota própria — seguem na estação", () => {
    // Declarado em vez de fingido: não há executor para esses dois.
    expect(resolveRoute("wsl", [servidor()]).kind).toBe("local");
    expect(resolveRoute("cloud", [servidor()]).kind).toBe("local");
  });

  it("VPS com um servidor habilitado roteia por SSH", () => {
    const rota = resolveRoute("vps", [servidor()]);
    expect(rota.kind).toBe("ssh");
    if (rota.kind === "ssh") expect(rota.server.host).toBe("vps.multiplike.local");
  });

  it("VPS sem servidor cadastrado BLOQUEIA, com o motivo", () => {
    // Cair para local aqui seria o engano antigo: o rodapé diz VPS e o
    // comando toca a estação.
    const rota = resolveRoute("vps", []);
    expect(rota.kind).toBe("blocked");
    if (rota.kind === "blocked") expect(rota.reason).toContain("nenhum servidor habilitado");
  });

  it("servidor desabilitado não conta", () => {
    expect(resolveRoute("vps", [servidor({ enabled: false })]).kind).toBe("blocked");
  });

  it("dois servidores habilitados BLOQUEIAM em vez de adivinhar", () => {
    const rota = resolveRoute("vps", [servidor(), servidor({ id: "s2", host: "outro.local" })]);
    expect(rota.kind).toBe("blocked");
    if (rota.kind === "blocked") expect(rota.reason).toContain("2 servidores");
  });
});

describe("routeLabel", () => {
  it("mostra o destino real na barra de status", () => {
    expect(routeLabel(resolveRoute("vps", [servidor()]))).toBe("deploy@vps.multiplike.local");
    expect(routeLabel({ kind: "local" })).toBe("estação");
    expect(routeLabel({ kind: "blocked", reason: "x" })).toBe("sem rota");
  });
});

describe("toTarget", () => {
  it("leva só metadado — nada de segredo", () => {
    const alvo = toTarget(servidor({ keyPath: "C:/Users/x/.ssh/id_ed25519" }));
    expect(alvo).toEqual({
      host: "vps.multiplike.local",
      port: 22,
      user: "deploy",
      authMethod: "agent",
      keyPath: "C:/Users/x/.ssh/id_ed25519",
      hostKeyFingerprint: undefined,
      remoteWorkdir: "/srv/app"
    });
    // O registro não tem campo de senha nem de conteúdo de chave; o alvo
    // também não pode ganhar um.
    expect(Object.keys(alvo)).not.toContain("password");
    expect(Object.keys(alvo)).not.toContain("privateKey");
  });

  it("carrega o fingerprint fixado, que é o que trava troca de chave", () => {
    expect(toTarget(servidor({ hostKeyFingerprint: "SHA256:abc" })).hostKeyFingerprint).toBe("SHA256:abc");
  });
});

describe("asTerminalResult", () => {
  it("veste o resultado remoto no formato do terminal", () => {
    expect(
      asTerminalResult("uptime", { exitCode: 0, stdout: "up 3 days", stderr: "", durationMs: 120 })
    ).toEqual({ command: "uptime", exitCode: 0, stdout: "up 3 days", stderr: "", durationMs: 120 });
  });

  it("preserva código de saída diferente de zero", () => {
    const resultado = asTerminalResult("falso", { exitCode: 1, stdout: "", stderr: "erro", durationMs: 5 });
    expect(resultado.exitCode).toBe(1);
    expect(resultado.stderr).toBe("erro");
  });
});
