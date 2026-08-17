"use client";

/**
 * Painel do Sandbox — a UI que faltava para o `sandbox_execute` do backend.
 *
 * O comando roda num diretório efêmero, com o ambiente LIMPO (`env_clear`),
 * PATH mínimo e dentro de um **Job Object** do Windows (ver src-tauri/jail.rs):
 * teto de processos e de memória, restrições de UI e — o principal — a árvore
 * INTEIRA morre no fim, inclusive netos órfãos.
 *
 * O que continua não sendo: redução de privilégio. Não é AppContainer nem
 * contêiner; o processo ainda carrega o token do usuário e alcança a rede. A
 * UI diz exatamente isso, sem prometer isolamento que não existe.
 */

import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { FlaskConical, Play, ShieldAlert } from "lucide-react";
import type { SandboxResult } from "@orchestrator/contracts";

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
        Roda num diretório temporário com ambiente limpo, dentro de um <strong>Job Object</strong>: teto de processos e
        memória, sem clipboard e a árvore inteira é encerrada no fim — inclusive netos órfãos. Não reduz privilégio: o
        processo continua com os <strong>seus</strong> direitos e alcança a rede.
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
            <span className="chip" title="Job Object do Windows: a árvore de processos morre junto">
              {result.jailed ? "job object" : "sem job object"}
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
