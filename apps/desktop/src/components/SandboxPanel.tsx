"use client";

/**
 * Painel do Sandbox — a UI que faltava para o `sandbox_execute` do backend.
 *
 * O comando roda num diretório efêmero, com o ambiente LIMPO (`env_clear`),
 * PATH mínimo e `kill_on_drop` no timeout. Isso NÃO é um jail de SO — o
 * processo ainda roda com os direitos do usuário — mas é contenção real, e a
 * UI diz exatamente o que é, sem prometer isolamento que não existe.
 */

import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { FlaskConical, Play, ShieldAlert } from "lucide-react";
import type { SandboxResult } from "@ai-orchestrator/contracts";

const isTauriHost = "__TAURI_INTERNALS__" in window;

export function SandboxPanel() {
  const [command, setCommand] = useState('echo Olá do sandbox && cd');
  const [result, setResult] = useState<SandboxResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");

  async function run() {
    if (!command.trim() || running) return;
    setRunning(true);
    setError("");
    setResult(null);
    try {
      const output = await invoke<SandboxResult>("sandbox_execute", {
        command,
        cwd: null,
        timeoutMs: 15_000
      });
      setResult(output);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="secx-sandbox">
      <p className="secx-sandbox__intro">
        Roda o comando num diretório temporário, com ambiente limpo e PATH mínimo — descartado ao fim. Contenção real,
        mas <strong>não é um jail de SO</strong>: o processo ainda tem os seus direitos.
      </p>
      <textarea
        className="secx-sandbox__cmd"
        value={command}
        onChange={(event) => setCommand(event.target.value)}
        rows={3}
        spellCheck={false}
        placeholder="comando a executar isolado…"
        aria-label="Comando do sandbox"
      />
      <button className="lg-button primary" onClick={() => void run()} disabled={running || !isTauriHost}>
        <Play size={13} />
        {running ? "Executando…" : "Executar no sandbox"}
      </button>
      {!isTauriHost ? (
        <p className="secx-sandbox__note">
          <ShieldAlert size={12} /> A execução isolada requer o app desktop.
        </p>
      ) : null}
      {error ? <p className="secx-sandbox__err">{error}</p> : null}
      {result ? (
        <div className="secx-sandbox__result">
          <div className="secx-sandbox__meta">
            <span className={`chip ${result.exitCode === 0 ? "ok" : "danger"}`}>saída {result.exitCode ?? "?"}</span>
            <span className="chip">
              <FlaskConical size={11} /> {result.isolated ? "ambiente limpo" : "sem isolamento"}
            </span>
            <span className="chip">{Math.round(result.durationMs)}ms</span>
          </div>
          {result.stdout ? <pre className="secx-sandbox__out">{result.stdout}</pre> : null}
          {result.stderr ? <pre className="secx-sandbox__out secx-sandbox__out--err">{result.stderr}</pre> : null}
        </div>
      ) : null}
    </div>
  );
}
