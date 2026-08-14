"use client";

/**
 * FLUXO — o editor visual de automações.
 *
 * A aba segue o mesmo desenho de todas as outras: as ações no topo, o balão de
 * prompt no rodapé e a área de trabalho no meio, sem toolbar interna comendo o
 * canvas. Já teve barra própria e campo de texto próprio; virou exceção sem
 * motivo, e uma exceção por aba é como um app deixa de parecer um app.
 *
 * Quem escreve no balão não está conversando: o texto vai pelo `goalBus` para
 * a montagem, e cada operação aparece no canvas assim que chega. O histórico
 * do que foi feito é uma coluna OPCIONAL — quem já sabe o que pediu não
 * precisa dela ocupando um terço da tela.
 *
 * É diferente da aba Agent de propósito. Lá o modelo decide o caminho a cada
 * execução; aqui o caminho é DESENHADO e não muda: mesmo gatilho, mesmo
 * percurso, sempre. Automação de negócio precisa ser previsível.
 */

import "../styles/modes/fluxo.css";

import { useEffect, useMemo, useState } from "react";
import { CircleAlert, Clock, GitBranch, Play, Plus, Save, Square, Trash2, Workflow, Zap } from "lucide-react";

import { FlowAssistant } from "../components/fluxo/FlowAssistant";
import { FlowCanvas } from "../components/fluxo/FlowCanvas";
import { NodePanel } from "../components/fluxo/NodePanel";
import { RailConversations } from "../components/RailConversations";
import { ThinkingOrb } from "../components/ThinkingOrb";
import { Glyph } from "../components/icons";
import { PanelScroll, PanelTitle, Surface, TopbarActions, VBody, VCenter, VStatus } from "../components/Primitives";
import { addCard, makeCard } from "../lib/automations";
import { montarDoPrompt } from "../lib/fluxo/build";
import { findNode, lintFlow, runFlow } from "../lib/fluxo/engine";
import { autoLayout } from "../lib/fluxo/layout";
import { applyOp } from "../lib/fluxo/ops";
import { useFluxo } from "../lib/fluxo/store";
import type { NodeType, RunResult } from "../lib/fluxo/types";
import { goalBus } from "../lib/ops";
import { useApp } from "../lib/store";
import { useWork } from "../lib/workEngine";

/* --------------------------------- rail --------------------------------- */

export function FluxoRail() {
  const flows = useFluxo((state) => state.flows);
  const activeId = useFluxo((state) => state.activeId);
  const selectFlow = useFluxo((state) => state.selectFlow);
  const toggle = useFluxo((state) => state.toggle);
  const remove = useFluxo((state) => state.remove);

  return (
    <>
      <PanelTitle label="Fluxos" />
      <PanelScroll>
        {flows.length === 0 ? (
          <p className="fxr-vazio">Nenhum fluxo ainda. Crie um em “Novo fluxo” e descreva o que ele deve fazer.</p>
        ) : null}
        {flows.map((flow) => (
          <div key={flow.id} className={`fxr-item ${activeId === flow.id ? "active" : ""}`}>
            <button type="button" className="fxr-main" onClick={() => selectFlow(flow.id)} title={flow.name}>
              <Glyph name="features/dag" size={13} />
              <span>{flow.name}</span>
              <small>{flow.definition.nodes.length}</small>
            </button>
            {/* "Ligado" é intenção declarada: nada dispara sozinho enquanto o
                agendador da aba Work não assumir estes gatilhos. */}
            <button
              type="button"
              className={`fxr-toggle ${flow.enabled ? "on" : ""}`}
              onClick={() => toggle(flow.id)}
              title={flow.enabled ? "Marcado como ativo" : "Marcado como inativo"}
            >
              {flow.enabled ? "on" : "off"}
            </button>
            <button type="button" className="icon-button" onClick={() => remove(flow.id)} aria-label={`Excluir ${flow.name}`}>
              <Trash2 size={12} />
            </button>
          </div>
        ))}
        <span className="eyebrow">CONVERSAS</span>
        <RailConversations mode="fluxo" />
      </PanelScroll>
    </>
  );
}

/* --------------------------------- view --------------------------------- */

const NOVOS: Array<{ type: NodeType; label: string; icone: typeof Zap; data: Record<string, unknown> }> = [
  { type: "trigger", label: "Gatilho", icone: Zap, data: { label: "Novo lead", triggerType: "new_lead" } },
  { type: "condition", label: "Condição", icone: GitBranch, data: { label: "Condição", field: "budget", operator: "greater_than", value: 1000 } },
  { type: "action", label: "Ação", icone: Plus, data: { label: "Enviar WhatsApp", actionType: "send_whatsapp", message: "Olá {{name}}!" } },
  { type: "wait", label: "Espera", icone: Clock, data: { label: "Aguardar", waitAmount: 1, waitUnit: "days" } }
];

export function FluxoView() {
  const flows = useFluxo((state) => state.flows);
  const activeId = useFluxo((state) => state.activeId);
  const draft = useFluxo((state) => state.draft);
  const selectedNode = useFluxo((state) => state.selectedNode);
  const building = useFluxo((state) => state.building);
  const note = useFluxo((state) => state.note);
  const assistantOpen = useFluxo((state) => state.assistantOpen);
  const toggleAssistant = useFluxo((state) => state.toggleAssistant);
  const stopBuild = useFluxo((state) => state.stopBuild);
  const stage = useApp((state) => state.stage);
  const newFlow = useFluxo((state) => state.newFlow);
  const rename = useFluxo((state) => state.rename);
  const patchNode = useFluxo((state) => state.patchNode);
  const setDraft = useFluxo((state) => state.setDraft);
  const select = useFluxo((state) => state.select);
  const save = useFluxo((state) => state.save);
  const setNote = useFluxo((state) => state.setNote);

  const [resultado, setResultado] = useState<RunResult | null>(null);
  const ativo = flows.find((flow) => flow.id === activeId) ?? null;
  const no = findNode(draft, selectedNode);
  const avisos = useMemo(() => lintFlow(draft), [draft]);
  const destaque = useMemo(() => new Set(resultado?.path ?? []), [resultado]);

  /**
   * O balão do app é a entrada desta aba.
   *
   * O handler lê tudo do store na hora de rodar (nada de fechar sobre o estado
   * do render): o `goalBus` guarda UM ouvinte por modo, e um registro que
   * mudasse a cada render abriria a janela em que o Enter chega para a versão
   * antiga da função.
   */
  useEffect(
    () =>
      goalBus.register("fluxo", (texto) => {
        void montarDoPrompt(texto, {
          selection: useApp.getState().settings.engines.fluxo,
          ctx: {
            session: useApp.getState().session,
            runtimeRunning: useApp.getState().runtimeStatus.running,
            fusionPresets: useApp.getState().settings.fusionPresets,
            baseOverrides: useApp.getState().settings.providerBaseOverrides
          }
        });
      }),
    []
  );

  /*
   * A montagem NÃO é abortada ao sair da aba.
   *
   * A view desmonta a cada troca de módulo, e o store de fluxo é de módulo
   * justamente para a montagem sobreviver a isso — abortar no cleanup era
   * fazer o oposto: ir ver o Chat por três segundos matava o trabalho no meio.
   * O que corre em segundo plano escreve no store, então voltar mostra o
   * resultado; para interromper de propósito existe o botão Parar.
   */

  function adicionar(item: (typeof NOVOS)[number]) {
    const id = `${item.type[0]}${Date.now().toString(36).slice(-4)}`;
    const comNo = applyOp(draft, { op: "add", id, type: item.type, data: item.data as never });
    setDraft(autoLayout(comNo));
    select(id);
  }

  function testar() {
    const saida = runFlow(draft);
    setResultado(saida);
    setNote(
      saida.status === "failed"
        ? (saida.error ?? "O teste falhou.")
        : saida.status === "waiting"
          ? `Teste parou na espera · ${saida.effects.length} efeito(s) até aqui.`
          : `Teste concluído · ${saida.path.length} etapa(s) · ${saida.effects.length} efeito(s).`
    );
    /**
     * "Criar tarefa" vira cartão no quadro Work de verdade.
     *
     * É o único efeito que atravessa para outro módulo, e é interno: quadro
     * do próprio app, nada sai para a rede. WhatsApp, webhook e HTTP ficam
     * LISTADOS — disparar de dentro de um botão "Testar" seria mandar
     * mensagem ao cliente para ver se o desenho está certo.
     */
    for (const efeito of saida.effects) {
      if (efeito.kind !== "create_task") continue;
      const board = useWork.getState().board;
      useWork.setState({ board: addCard(board, board.lanes[0]?.name ?? "A fazer", makeCard(efeito.message)) });
    }
  }

  /** Botão do histórico — igual nos dois estados da aba, com ou sem fluxo. */
  const botaoAssistente = (
    <button
      type="button"
      className={`icon-button ${assistantOpen ? "active" : ""}`}
      onClick={toggleAssistant}
      title={assistantOpen ? "Ocultar histórico da montagem" : "Mostrar histórico da montagem"}
      aria-pressed={assistantOpen}
    >
      <Glyph name="ui/panel-left" size={14} />
    </button>
  );

  if (!ativo) {
    return (
      <Surface className="fx-view">
        {/* A topbar existe nos DOIS estados: sem isto, criar o primeiro fluxo
            fazia a barra do topo aparecer do nada e a tela pular. */}
        <TopbarActions>
          <button type="button" className="lg-button primary" onClick={newFlow}>
            <Plus size={13} />
            <span className="tb-label">Novo fluxo</span>
          </button>
          {botaoAssistente}
        </TopbarActions>
        <VBody>
          <VCenter>
            <div className="fx-hero">
              <Workflow size={26} />
              <strong>Fluxos de automação</strong>
              <p>
                Desenhe o que acontece depois de um gatilho — ou descreva no campo abaixo e veja o fluxo ser montado na
                tela. Diferente da aba Agent, aqui o caminho é fixo: mesmo gatilho, mesmo percurso, sempre.
              </p>
              <button type="button" className="lg-button primary" onClick={newFlow}>
                <Plus size={13} />
                Criar o primeiro fluxo
              </button>
            </div>
          </VCenter>
        </VBody>
        <VStatus>Nenhum fluxo</VStatus>
      </Surface>
    );
  }

  return (
    <Surface className="fx-view">
      <TopbarActions>
        <input
          className="fx-nome"
          value={ativo.name}
          onChange={(event) => rename(ativo.id, event.target.value)}
          aria-label="Nome do fluxo"
        />
        {/* Os quatro tipos de nó ficam agrupados: são a mesma decisão ("o que
            entra agora?"), e quatro botões soltos disputariam atenção com
            Testar e Salvar, que são decisões de outra natureza. */}
        <div className="segmented segmented--acoes">
          {NOVOS.map((item) => (
            <button
              key={item.type}
              type="button"
              title={`Adicionar ${item.label.toLowerCase()}`}
              disabled={building}
              onClick={() => adicionar(item)}
            >
              <item.icone size={13} />
              <span className="tb-label">{item.label}</span>
            </button>
          ))}
        </div>
        <button type="button" className="lg-button" onClick={testar} disabled={building}>
          <Play size={13} />
          <span className="tb-label">Testar</span>
        </button>
        <button type="button" className="lg-button primary" onClick={save} disabled={building}>
          <Save size={13} />
          <span className="tb-label">Salvar</span>
        </button>
        {botaoAssistente}
      </TopbarActions>

      <VBody>
        <VCenter className="fx-center">
          <div className={`fx-shell ${assistantOpen ? "" : "sem-assistente"}`}>
            {assistantOpen ? (
              <aside className="fx-left">
                <FlowAssistant />
              </aside>
            ) : null}

            <div className="fx-main">
              {building ? (
                <div className="fx-montando">
                  {/* Sem auréola: numa faixa de texto ela só engorda a linha —
                      o brilho vale no balão flutuante, que é peça solta. */}
                  <ThinkingOrb kind="weaving" size={20} className="orb--inline" />
                  {/* A etapa que o `montarDoPrompt` escreve aparece AQUI. A
                      aba não tem o balão de "processando" das outras (o envio
                      desvia antes do `sending`), então sem esta linha o texto
                      era escrito para ninguém. */}
                  <span className="fx-montando-etapa">{stage || "Montando o fluxo…"}</span>
                  {/* Parar precisa existir no estado PADRÃO da aba: a coluna
                      do histórico nasce fechada, e o botão dela não bastava. */}
                  <button type="button" className="lg-button ghost" onClick={stopBuild}>
                    <Square size={12} />
                    Parar
                  </button>
                </div>
              ) : null}

              {avisos.length > 0 ? (
                <div className="fx-avisos">
                  <CircleAlert size={12} />
                  <span>{avisos[0]}</span>
                  {avisos.length > 1 ? <em>+{avisos.length - 1}</em> : null}
                </div>
              ) : null}

              <div className="fx-canvas">
                <FlowCanvas definition={draft} destaque={destaque} />
              </div>

              {resultado ? (
                <div className="fx-trilha">
                  <span className="eyebrow">
                    Teste · {resultado.status === "ok" ? "concluído" : resultado.status === "waiting" ? "parou na espera" : "falhou"}
                  </span>
                  <ol>
                    {resultado.logs.map((log, indice) => (
                      <li key={`${log.nodeId}-${indice}`} className={`st-${log.status}`}>
                        {log.message}
                      </li>
                    ))}
                  </ol>
                  {resultado.effects.length ? (
                    <p className="fx-efeitos">
                      Sairiam do app: {resultado.effects.map((efeito) => efeito.kind).join(", ")} — no teste nada é
                      enviado.
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>

            {no ? (
              <aside className="fx-right">
                <NodePanel
                  node={no}
                  onChange={(patch) => patchNode(no.id, patch)}
                  onRemove={() => {
                    setDraft(applyOp(draft, { op: "remove", id: no.id }));
                    select(null);
                  }}
                  onClose={() => select(null)}
                />
              </aside>
            ) : null}
          </div>
        </VCenter>
      </VBody>
      <VStatus>
        {note || `${draft.nodes.length} nó(s) · ${draft.edges.length} ligação(ões)`}
      </VStatus>
    </Surface>
  );
}
