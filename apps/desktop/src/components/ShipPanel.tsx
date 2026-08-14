"use client";

/**
 * Painel de build/deploy — carrega o projeto (GitHub, pasta ou artefato),
 * mostra a stack detectada com a evidência, executa o pipeline ao vivo e
 * versiona quando tudo passa.
 */

import { useState } from "react";
import { Surface } from "./Primitives";
import { cancelRun, detectFrom, selectStack, setVersion, startRun, suggestedBump, useShip } from "../lib/ship/session";
import { artifactRunHint, resolveSource, sourceLabel, type SourceKind } from "../lib/ship/source";
import { bumpVersion, canRelease, planRelease, type StepStatus } from "../lib/ship/pipeline";
import type { DetectedStack } from "../lib/ship/stack";
import { generateDockerfile } from "../lib/ship/dockerfile";
import type { FrameworkDetectado } from "../lib/ship/stacks";

const KINDS: Array<{ id: SourceKind; label: string; placeholder: string }> = [
  { id: "github", label: "GitHub", placeholder: "owner/repo ou https://github.com/..." },
  { id: "folder", label: "Pasta local", placeholder: "C:\\Users\\voce\\Code\\projeto" },
  { id: "artifact", label: "Artefato", placeholder: "C:\\dist\\app.zip ou api.jar" }
];

const STATUS_ICON: Record<StepStatus, string> = {
  pending: "○",
  running: "◐",
  ok: "✓",
  failed: "✗",
  skipped: "–",
  cancelled: "⊘"
};

export function ShipPanel({ root }: { root: string }) {
  const { source, stacks, frameworks, selected, detecting, run, version } = useShip();
  const [kind, setKind] = useState<SourceKind>("folder");
  const [input, setInput] = useState(root);
  const [error, setError] = useState("");
  const [openStep, setOpenStep] = useState("");
  /** Índice do framework escolhido — o primeiro é o de maior confiança. */
  const [frameworkAtivo, setFrameworkAtivo] = useState(0);
  const [verDockerfile, setVerDockerfile] = useState(false);
  /**
   * A pasta que foi CARREGADA — não a do editor.
   *
   * O painel detectava a stack na pasta digitada aqui e mandava o build rodar
   * em `root`, que é a raiz aberta na aba Code. Carregar a pasta B com o
   * editor em A analisava B e compilava A: o log dizia "Next.js" e o comando
   * caía num projeto que podia nem ser Node. Agora as duas coisas usam o
   * mesmo caminho.
   */
  const [carregado, setCarregado] = useState(root);

  const load = async () => {
    const result = resolveSource(kind, input);
    if (!result.ok) {
      setError(result.reason);
      return;
    }
    setError("");
    // GitHub ainda precisa do clone; por ora detecta sobre a pasta corrente.
    const scanRoot = result.source.kind === "folder" ? result.source.path : root;
    setCarregado(scanRoot);
    await detectFrom(result.source, scanRoot);
  };

  const running = run?.status === "running";
  const releasable = run ? canRelease(run) : false;
  const nextVersion = bumpVersion(version, suggestedBump());

  return (
    <Surface className="ship">
      <header className="ship__head">
        <div className="ship__kinds" role="tablist">
          {KINDS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={kind === entry.id}
              className={`ship__kind${kind === entry.id ? " is-active" : ""}`}
              onClick={() => setKind(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </div>
        <div className="ship__load">
          <input
            className="ship__input"
            value={input}
            placeholder={KINDS.find((entry) => entry.id === kind)?.placeholder}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && void load()}
            aria-label="Origem do projeto"
          />
          <button type="button" className="ship__go" onClick={() => void load()} disabled={detecting}>
            {detecting ? "Analisando…" : "Carregar"}
          </button>
        </div>
        {error ? <p className="ship__error">{error}</p> : null}
      </header>

      {source ? (
        <p className="ship__source">
          <strong>{sourceLabel(source)}</strong>
          {source.kind === "artifact" ? (
            <span className="ship__hint">
              {" "}
              · artefato {source.format}
              {artifactRunHint(source) ? ` · ${artifactRunHint(source)}` : ""}
            </span>
          ) : null}
        </p>
      ) : null}

      {stacks.length ? (
        <section className="ship__stacks">
          <h4 className="ship__title">Stack detectada</h4>
          {stacks.map((stack) => (
            <StackChip key={stack.id} stack={stack} active={selected?.id === stack.id} onPick={() => selectStack(stack)} />
          ))}
        </section>
      ) : null}

      {frameworks.length ? (
        <section className="ship__stacks">
          <h4 className="ship__title">Framework — como a imagem sobe</h4>
          {/*
            Isto é a outra metade da resposta. "Stack detectada" acima diz a
            LINGUAGEM e os comandos do pipeline; aqui está o framework, que é
            quem sabe a porta, a pasta de saída e o comando de start — os
            valores de que o Dockerfile depende. Antes o catálogo das 47
            stacks existia no código e não chegava a lugar nenhum.
          */}
          {frameworks.slice(0, 4).map((achado, indice) => (
            <FrameworkChip
              key={achado.id}
              achado={achado}
              active={indice === frameworkAtivo}
              onPick={() => {
                setFrameworkAtivo(indice);
                setVerDockerfile(false);
              }}
            />
          ))}
          <button
            type="button"
            className="ship__go ship__dockerfile-toggle"
            onClick={() => setVerDockerfile((valor) => !valor)}
          >
            {verDockerfile ? "Ocultar Dockerfile" : "Ver Dockerfile"}
          </button>
          {verDockerfile && frameworks[frameworkAtivo] ? (
            <pre className="ship__out ship__out--plan">
              {generateDockerfile({
                stack: frameworks[frameworkAtivo].stack,
                buildCommand: frameworks[frameworkAtivo].stack.defaultBuildCommand || undefined,
                startCommand: frameworks[frameworkAtivo].stack.defaultStartCommand || undefined
              })}
            </pre>
          ) : null}
        </section>
      ) : null}

      {run && run.steps.length ? (
        <section className="ship__run">
          <div className="ship__runhead">
            <h4 className="ship__title">Pipeline</h4>
            {running ? (
              <button type="button" className="ship__stop" onClick={cancelRun}>
                Parar
              </button>
            ) : (
              <button type="button" className="ship__go" onClick={() => void startRun(carregado)} disabled={!selected}>
                Executar
              </button>
            )}
          </div>
          <ol className="ship__steps">
            {run.steps.map((step) => (
              <li key={step.id} className={`ship__step is-${step.status}`}>
                <button type="button" className="ship__steprow" onClick={() => setOpenStep(openStep === step.id ? "" : step.id)}>
                  <span className="ship__icon" aria-hidden>
                    {STATUS_ICON[step.status]}
                  </span>
                  <span className="ship__stepname">{step.step}</span>
                  <code className="ship__cmd">{step.command}</code>
                  {step.durationMs ? <span className="ship__ms">{Math.round(step.durationMs)}ms</span> : null}
                </button>
                {openStep === step.id && step.output ? <pre className="ship__out">{step.output}</pre> : null}
              </li>
            ))}
          </ol>
        </section>
      ) : selected && selected.id !== "unknown" ? (
        <button type="button" className="ship__go ship__go--wide" onClick={() => void startRun(carregado)}>
          Executar build
        </button>
      ) : null}

      <section className="ship__version">
        <h4 className="ship__title">Versão</h4>
        <p className="ship__vrow">
          <span className="ship__vnow">{version}</span>
          {releasable ? (
            <>
              <span aria-hidden>→</span>
              <span className="ship__vnext">{nextVersion}</span>
              <button type="button" className="ship__go" onClick={() => setVersion(nextVersion)}>
                Marcar
              </button>
            </>
          ) : (
            <span className="ship__hint">Rode o pipeline inteiro para liberar o versionamento.</span>
          )}
        </p>
        {releasable ? (
          <pre className="ship__out ship__out--plan">{planRelease(nextVersion, `build ${selected?.label ?? ""}`, false).commands.join("\n")}</pre>
        ) : null}
      </section>
    </Surface>
  );
}

function FrameworkChip({
  achado,
  active,
  onPick
}: {
  achado: FrameworkDetectado;
  active: boolean;
  onPick: () => void;
}) {
  return (
    <button type="button" className={`ship__stack${active ? " is-active" : ""}`} onClick={onPick}>
      <span className="ship__stacklabel">
        {achado.stack.name}
        <em> · porta {achado.stack.defaultPort}</em>
      </span>
      <span className="ship__evidence">
        detectado por {achado.evidencia} · saída em {achado.stack.outputDirectory}
      </span>
    </button>
  );
}

function StackChip({ stack, active, onPick }: { stack: DetectedStack; active: boolean; onPick: () => void }) {
  return (
    <button type="button" className={`ship__stack${active ? " is-active" : ""}`} onClick={onPick} disabled={stack.id === "unknown"}>
      <span className="ship__stacklabel">
        {stack.label}
        {stack.variant ? <em> · {stack.variant}</em> : null}
      </span>
      {stack.evidence ? <span className="ship__evidence">detectado por {stack.evidence}</span> : null}
    </button>
  );
}
