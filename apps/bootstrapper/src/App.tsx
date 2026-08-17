import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Check, Download, Gauge, Pause, Play, RefreshCw, Sparkles, X } from "lucide-react";

type Phase = "idle" | "preparing" | "downloading" | "paused" | "verifying" | "installing" | "starting" | "complete" | "error" | "cancelled";

interface ProgressEvent {
  phase: Phase;
  downloaded: number;
  total: number;
  bytesPerSecond: number;
  etaSeconds: number | null;
  message: string;
}

const formatBytes = (bytes: number) => {
  if (!bytes) return "0 MB";
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
};

const formatEta = (seconds: number | null) => {
  if (seconds == null) return "Calculando";
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
};

const phaseLabels: Record<Phase, string> = {
  idle: "Preparando",
  preparing: "Preparando",
  downloading: "Baixando",
  paused: "Pausado",
  verifying: "Verificando",
  installing: "Finalizando",
  starting: "Iniciando",
  complete: "Concluído",
  error: "Interrompido",
  cancelled: "Cancelado"
};

export default function App() {
  const [progress, setProgress] = useState<ProgressEvent>({
    phase: "idle",
    downloaded: 0,
    total: 0,
    bytesPerSecond: 0,
    etaSeconds: null,
    message: ""
  });

  const percent = progress.total
    ? Math.min(100, (progress.downloaded / progress.total) * 100)
    : progress.phase === "complete"
      ? 100
      : 0;

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void (async () => {
      unlisten = await listen<ProgressEvent>("installer-progress", (event) => setProgress(event.payload));
      if (!disposed) {
        await invoke("begin_install").catch(() => setProgress((value) => ({ ...value, phase: "error" })));
      }
    })();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const headline = useMemo(() => {
    if (progress.phase === "complete") return "Tudo pronto.";
    if (progress.phase === "error") return "Não foi possível concluir.";
    if (progress.phase === "cancelled") return "Instalação cancelada.";
    return "Instalando AI-Orchestrator";
  }, [progress.phase]);

  const showError = progress.phase === "error" || progress.phase === "cancelled";

  return (
    <main className="installer">
      <div className="glow glow-a" />
      <div className="glow glow-b" />
      <div className="noise" />

      <section className="card">
        <header className="brand" data-tauri-drag-region>
          <span className="brand-mark"><Sparkles size={19} /></span>
          <div><strong>AI-Orchestrator</strong><small>SETUP</small></div>
          <button className="close-setup" onClick={() => void invoke("close_installer")} aria-label="Fechar instalador"><X size={16} /></button>
        </header>

        <section className="install-copy">
          <span className="kicker">PREPARANDO PARA VOCÊ</span>
          <h1>{headline}</h1>
          {showError
            ? <p>Verifique sua conexão e tente novamente. Seu progresso foi preservado.</p>
            : <p>O aplicativo abrirá automaticamente quando estiver pronto.</p>}
        </section>

        <section className={`progress-panel phase-${progress.phase}`}>
          <div className="progress-heading">
            <div className="phase-state">
              {progress.phase === "complete"
                ? <span className="complete-mark"><Check size={15} /></span>
                : <span className="download-pulse"><i /><i /><i /></span>}
              <strong>{phaseLabels[progress.phase]}</strong>
            </div>
            <span className="percent">{percent.toFixed(0)}%</span>
          </div>

          <div className="track" role="progressbar" aria-label="Progresso da instalação" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)}>
            <i style={{ width: `${percent}%` }}><b /></i>
          </div>

          <div className="metrics">
            <div><Download size={14} /><span>{formatBytes(progress.downloaded)} <small>/ {formatBytes(progress.total)}</small></span></div>
            <div><Gauge size={14} /><span>{formatBytes(progress.bytesPerSecond)}/s</span></div>
            <div><small>Tempo restante</small><strong>{formatEta(progress.etaSeconds)}</strong></div>
          </div>
        </section>

        <footer>
          <span className="quiet-status">Download seguro e verificado</span>
          <div className="actions">
            {progress.phase === "downloading" && <button className="secondary" onClick={() => void invoke("pause_install")}><Pause size={15} />Pausar</button>}
            {progress.phase === "paused" && <button className="primary" onClick={() => void invoke("resume_install")}><Play size={15} />Continuar</button>}
            {showError && <button className="primary" onClick={() => void invoke("retry_install")}><RefreshCw size={15} />Tentar novamente</button>}
            {!['complete', 'starting', 'error', 'cancelled'].includes(progress.phase) && <button className="ghost" onClick={() => void invoke("cancel_install")}>Cancelar</button>}
          </div>
        </footer>
      </section>
    </main>
  );
}
