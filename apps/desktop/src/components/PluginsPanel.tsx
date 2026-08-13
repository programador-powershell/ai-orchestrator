"use client";

/**
 * Plugins e trilha — a seção de Configurações.
 *
 * Duas coisas na mesma tela porque são o mesmo assunto: o que entra no prompt
 * e como conferir o que entrou.
 *
 * O que a pessoa pode fazer aqui é **só do agente dela**. Os plugins globais
 * aparecem em modo leitura, identificados como da administração — mostrar que
 * existem, sem dar a ilusão de que dá para desligá-los, é mais honesto que
 * escondê-los.
 */

import { useMemo, useState } from "react";
import { CircleAlert, Download, Plug, Trash2, Waypoints } from "lucide-react";

import { useApp } from "../lib/store";
import { usePlugins } from "../lib/pluginStore";
import { resolve } from "../lib/plugins";
import { useTrajectory } from "../lib/trajectoryStore";
import { HARNESS_MODE_HINT, HARNESS_MODE_LABEL, type HarnessMode } from "../lib/contextAssembly";
import { SOURCE_LABEL, bySource, exportText, summarize } from "../lib/trajectory";

const EXEMPLO = `{
  "id": "cep-interno",
  "name": "Consulta de CEP",
  "version": "1.0.0",
  "prompt": "Para endereço, use a ferramenta de CEP em vez de adivinhar.",
  "tools": [
    {
      "name": "buscar",
      "description": "Busca o endereço de um CEP",
      "kind": "http",
      "target": "https://servico.interno/cep/{cep}",
      "params": [{ "name": "cep", "description": "CEP com 8 dígitos", "required": true }]
    }
  ]
}`;

const MODOS: HarnessMode[] = ["standard", "minimal"];

export function PluginsPanel() {
  const policy = useApp((state) => state.policy);
  const registry = usePlugins((state) => state.registry);
  const userPlugins = usePlugins((state) => state.userPlugins);
  const rejected = usePlugins((state) => state.rejected);
  const addUserPlugin = usePlugins((state) => state.addUserPlugin);
  const removeUserPlugin = usePlugins((state) => state.removeUserPlugin);

  const trajectory = useTrajectory((state) => state.current);
  const skipped = useTrajectory((state) => state.skipped);
  const harnessMode = useTrajectory((state) => state.harnessMode);
  const setHarnessMode = useTrajectory((state) => state.setHarnessMode);

  const [rascunho, setRascunho] = useState("");
  const [erro, setErro] = useState("");

  const allowed = policy?.userPluginsAllowed ?? false;
  const globais = useMemo(
    () => registry.plugins.filter((item) => item.scope === "global"),
    [registry]
  );
  // A aba CORRENTE, não "agent" fixo: o contador dizia "0 ativos nesta aba"
  // para um plugin restrito ao Security enquanto a pessoa estava no Security
  // — e o contrário no Chat. Quem depura tirava a conclusão errada sobre o
  // que entrou no prompt.
  const abaAtual = useApp((state) => state.mode);
  const ativos = useMemo(
    () => resolve(registry, { mode: abaAtual, userPluginsAllowed: allowed }),
    [registry, allowed, abaAtual]
  );
  const participacao = trajectory ? bySource(trajectory) : [];
  const resumo = trajectory ? summarize(trajectory, Date.now()) : null;

  function salvar() {
    const resultado = addUserPlugin(rascunho);
    if (!resultado.ok) {
      setErro(resultado.reason);
      return;
    }
    setErro("");
    setRascunho("");
  }

  function baixarTrilha() {
    if (!trajectory) return;
    const blob = new Blob([exportText(trajectory, Date.now())], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `trilha-${trajectory.id}.txt`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="plgx">
      <section className="setx-section">
        <header>
          <h3>Modo do harness</h3>
          <p>
            Quantas fontes de contexto entram no prompt. O modo mínimo serve para descobrir se um resultado
            ruim é do modelo ou do que injetamos junto.
          </p>
        </header>
        <div className="plgx-modes">
          {MODOS.map((modo) => (
            <button
              key={modo}
              className={`chip${harnessMode === modo ? " accent" : ""}`}
              onClick={() => setHarnessMode(modo)}
            >
              {HARNESS_MODE_LABEL[modo]}
            </button>
          ))}
        </div>
        <small className="plgx-hint">{HARNESS_MODE_HINT[harnessMode]}</small>
        {harnessMode === "minimal" && (
          <small className="plgx-hint">
            O <strong>prompt master da administração continua entrando</strong> — nenhum modo o remove.
          </small>
        )}
      </section>

      <section className="setx-section">
        <header>
          <h3>
            <Plug size={13} /> Plugins
          </h3>
          <p>
            Um plugin descreve uma ferramenta ou um trecho de contexto. Ele é <strong>declarativo</strong>: não
            executa código, e sai pelos mesmos caminhos com guarda que o resto do app usa.
          </p>
        </header>

        <div className="plgx-group">
          <span className="eyebrow">Da administração · {globais.length}</span>
          {!globais.length ? (
            <small className="plgx-hint">Nenhum plugin global definido para o seu grupo.</small>
          ) : (
            globais.map((item) => (
              <article key={item.manifest.id} className="plgx-card global">
                <header>
                  <strong>{item.manifest.name}</strong>
                  <span className="chip">global</span>
                </header>
                <small>
                  {item.manifest.description || item.manifest.id} · v{item.manifest.version} ·{" "}
                  {item.tools.length} ferramenta(s)
                </small>
              </article>
            ))
          )}
        </div>

        <div className="plgx-group">
          <span className="eyebrow">Seus · {userPlugins.length}</span>
          {!allowed && (
            <div className="plgx-locked">
              <CircleAlert size={13} />
              A política do seu grupo não libera plugin próprio. O que você já salvou fica guardado, mas não é
              carregado.
            </div>
          )}
          {userPlugins.map((item) => (
            <article key={item.id} className="plgx-card">
              <header>
                <strong>{item.name}</strong>
                <span className="chip">seu</span>
                <button className="lg-icon-button" onClick={() => removeUserPlugin(item.id)} title="Remover">
                  <Trash2 size={12} />
                </button>
              </header>
              <small>
                {item.description || item.id} · v{item.version} · {item.tools?.length ?? 0} ferramenta(s)
              </small>
            </article>
          ))}
          <label className="lg-field">
            Novo plugin (JSON)
            <textarea
              rows={8}
              value={rascunho}
              onChange={(event) => setRascunho(event.target.value)}
              placeholder={EXEMPLO}
              spellCheck={false}
              disabled={!allowed}
            />
          </label>
          {erro && (
            <div className="plgx-error">
              <CircleAlert size={13} />
              {erro}
            </div>
          )}
          <div className="plgx-actions">
            <button className="lg-button" onClick={() => setRascunho(EXEMPLO)} disabled={!allowed}>
              Usar exemplo
            </button>
            <button className="lg-button primary" onClick={salvar} disabled={!allowed || !rascunho.trim()}>
              Salvar plugin
            </button>
          </div>
        </div>

        {/* Recusa não pode ser silenciosa: quem escreveu o manifesto precisa
            saber o que corrigir, e o admin precisa saber que o dele não subiu. */}
        {rejected.length > 0 && (
          <div className="plgx-group">
            <span className="eyebrow">Não carregados · {rejected.length}</span>
            {rejected.map((item) => (
              <div className="plgx-error" key={`${item.id}-${item.reason}`}>
                <CircleAlert size={13} />
                <strong>{item.id}</strong>: {item.reason}
              </div>
            ))}
          </div>
        )}

        <small className="plgx-hint">
          Ativos nesta aba: {ativos.length} plugin(s), {ativos.reduce((soma, item) => soma + item.tools.length, 0)}{" "}
          ferramenta(s).
        </small>
      </section>

      <section className="setx-section">
        <header>
          <h3>
            <Waypoints size={13} /> Trilha da última execução
          </h3>
          <p>
            O que o modelo viu, por origem. É o que responde <em>por que ele respondeu isso</em> quando a
            resposta sai estranha.
          </p>
        </header>
        {!trajectory ? (
          <small className="plgx-hint">Envie uma mensagem para a trilha aparecer aqui.</small>
        ) : (
          <>
            <div className="plgx-summary">
              <span>{resumo?.events} evento(s)</span>
              <span>{resumo?.contextChars} caracteres de contexto</span>
              {resumo?.dropped ? <span className="bad">{resumo.dropped} descartado(s)</span> : null}
              <button className="lg-button ghost" onClick={baixarTrilha} title="Baixar para anexar a um chamado">
                <Download size={12} />
                Exportar
              </button>
            </div>
            <div className="plgx-bars">
              {participacao.map((item) => (
                <div className="plgx-bar" key={item.source}>
                  <span className="plgx-bar-label">{SOURCE_LABEL[item.source]}</span>
                  <span className="plgx-bar-track">
                    <i style={{ width: `${Math.max(2, Math.round(item.share * 100))}%` }} />
                  </span>
                  <small>
                    {item.chars} car. · {Math.round(item.share * 100)}%
                  </small>
                </div>
              ))}
            </div>
            {skipped.length > 0 && (
              <small className="plgx-hint">
                Barrado pelo modo {HARNESS_MODE_LABEL[harnessMode].toLowerCase()}:{" "}
                {skipped.map((source) => SOURCE_LABEL[source]).join(", ")}.
              </small>
            )}
          </>
        )}
      </section>
    </div>
  );
}
