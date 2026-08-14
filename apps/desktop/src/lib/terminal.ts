/**
 * Terminal do app — e o roteamento por ambiente.
 *
 * `execute` respeita a escolha do rodapé: no ambiente **VPS** o comando sai
 * pelo cliente SSH para o servidor cadastrado; nos demais roda na estação.
 * Antes a escolha não influenciava nada, e o badge dizia "VPS" enquanto o
 * comando tocava a máquina de quem clicou.
 *
 * Quando o ambiente pede uma rota que não existe (VPS sem servidor, ou dois
 * habilitados), o comando **não roda** — ele volta com o motivo. Cair para
 * local em silêncio seria repetir o engano com uma cara nova.
 */
import { invoke } from "@tauri-apps/api/core";
import type { LanguageRuntime, TerminalResult } from "@multiplike/contracts";

import { asTerminalResult, resolveRoute, ssh, toTarget } from "./ssh";
import { useApp } from "./store";

async function executeRouted(command: string, cwd?: string): Promise<TerminalResult> {
  const settings = useApp.getState().settings;
  const rota = resolveRoute(settings.environment ?? "local", settings.deployServers ?? []);
  if (rota.kind === "blocked") {
    return { command, exitCode: undefined, stdout: "", stderr: rota.reason, durationMs: 0 };
  }
  if (rota.kind === "ssh") {
    const resultado = await ssh.exec(toTarget(rota.server), command);
    return asTerminalResult(command, resultado);
  }
  return invoke<TerminalResult>("terminal_execute", { command, cwd });
}

export const terminal = {
  catalog: () => invoke<LanguageRuntime[]>("terminal_catalog"),
  execute: (command: string, cwd?: string) => executeRouted(command, cwd),
  /** Força a estação, ignorando o ambiente — para o que é local por natureza. */
  executeLocal: (command: string, cwd?: string) =>
    invoke<TerminalResult>("terminal_execute", { command, cwd }),
  installRuntime: (runtimeId: string) => invoke<void>("terminal_runtime_install", { runtimeId })
};
