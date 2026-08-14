/**
 * Roteamento de execução por AMBIENTE — o que fazia o badge do rodapé ser
 * decorativo.
 *
 * `settings.environment` era lido só para desenhar: qualquer que fosse a
 * escolha, o comando rodava na estação. Quem lia "VPS" no rodapé assumia que o
 * comando não tocava a máquina dele, e tocava — o mesmo gating cosmético que o
 * resto do produto eliminou.
 *
 * Aqui a escolha decide de fato: `vps` manda o comando pelo cliente SSH do
 * sistema, para o servidor cadastrado. Os demais continuam na estação, porque
 * é o que existe — WSL e nuvem seguem sem rota própria, e o módulo diz isso em
 * vez de fingir.
 *
 * Nenhum segredo passa por aqui: a autenticação é do agente SSH ou de um
 * arquivo de chave apontado por caminho, e quem lida com isso é o OpenSSH.
 *
 * A parte pura (escolha da rota) é coberta por ssh.test.ts.
 */

import { invoke } from "@tauri-apps/api/core";
import type { FsEntry, TerminalResult } from "@multiplike/contracts";

import type { DeployServer } from "./ship/server";
import { useApp } from "./store";

export type Environment = "local" | "wsl" | "vps" | "cloud";

export interface SshTarget {
  host: string;
  port: number;
  user: string;
  authMethod: string;
  keyPath?: string;
  hostKeyFingerprint?: string;
  remoteWorkdir?: string;
}

export interface SshResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export function toTarget(server: DeployServer): SshTarget {
  return {
    host: server.host,
    port: server.port,
    user: server.user,
    authMethod: server.authMethod,
    keyPath: server.keyPath,
    hostKeyFingerprint: server.hostKeyFingerprint,
    remoteWorkdir: server.remoteWorkdir
  };
}

/**
 * Para onde este comando vai.
 *
 * Devolve o MOTIVO quando a rota pedida não existe — "roda local mesmo" sem
 * explicação é como o badge enganava antes.
 */
export type Route =
  | { kind: "local" }
  | { kind: "ssh"; server: DeployServer }
  | { kind: "blocked"; reason: string };

export function resolveRoute(environment: Environment, servers: DeployServer[]): Route {
  if (environment !== "vps") return { kind: "local" };
  const ativos = servers.filter((server) => server.enabled);
  if (!ativos.length) {
    return {
      kind: "blocked",
      reason: "o ambiente VPS está selecionado, mas nenhum servidor habilitado está cadastrado em Configurações → Servidor VPS"
    };
  }
  if (ativos.length > 1) {
    // Escolher sozinho entre dois servidores seria adivinhar em qual máquina
    // rodar um comando — exatamente o tipo de palpite que não se faz.
    return {
      kind: "blocked",
      reason: `há ${ativos.length} servidores habilitados; deixe apenas um habilitado para o ambiente VPS`
    };
  }
  return { kind: "ssh", server: ativos[0] };
}

/** Rótulo curto de onde o comando roda, para a barra de status. */
export function routeLabel(route: Route): string {
  if (route.kind === "ssh") return `${route.server.user}@${route.server.host}`;
  if (route.kind === "blocked") return "sem rota";
  return "estação";
}

export const ssh = {
  exec: (target: SshTarget, command: string) => invoke<SshResult>("ssh_exec", { target, command }),
  fingerprint: (host: string, port: number) => invoke<string>("ssh_fingerprint", { host, port }),
  read: (target: SshTarget, path: string) => invoke<string>("ssh_read", { target, path }),
  write: (target: SshTarget, path: string, content: string) =>
    invoke<void>("ssh_write", { target, path, content }),
  list: (target: SshTarget, sub: string) => invoke<FsEntry[]>("ssh_list", { target, sub })
};

/**
 * Rota atual, lida do estado da aplicação.
 *
 * Fica aqui e não em cada chamador porque o ponto do roteamento é ser **um
 * só**: com cada aba resolvendo a rota do seu jeito, uma delas ficaria para
 * trás — que foi exatamente o que aconteceu quando só o terminal roteava e os
 * arquivos não.
 */
export function currentRoute(): Route {
  const settings = useApp.getState().settings;
  return resolveRoute(settings.environment ?? "local", settings.deployServers ?? []);
}

/**
 * Converte o resultado do SSH no formato do terminal, para quem chama não
 * precisar saber por onde o comando foi.
 */
export function asTerminalResult(command: string, result: SshResult): TerminalResult {
  return {
    command,
    // O contrato do terminal usa `undefined` para "sem código de saída"; o
    // Rust manda `null`. Deixar o null passar faria a UI imprimir "null".
    exitCode: result.exitCode ?? undefined,
    stdout: result.stdout,
    stderr: result.stderr,
    durationMs: result.durationMs
  };
}
