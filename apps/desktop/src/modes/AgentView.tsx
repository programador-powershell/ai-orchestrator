/**
 * Agent — a equipe, e só ela.
 *
 * A aba não oferece modos. Antes havia quatro superfícies ("Agentes", "Livre",
 * "Spec" e "Fluxo") e a pessoa escolhia como os agentes trabalhariam: um grafo
 * desenhado à mão, uma delegação livre ou o passo a passo spec-driven. Escolher
 * o método nunca foi trabalho de quem pede — é decisão de arquitetura, e tê-la
 * na tela significava três caminhos para o mesmo pedido, cada um com um
 * comportamento diferente e nenhum deles o padrão.
 *
 * Agora existe um caminho: você escreve o que quer no composer, o modelo
 * ORQUESTRADOR lê o pedido, decide o tamanho da equipe e ela roda sempre na
 * mesma espinha — constituição → especificação → plano → tarefas → revisão →
 * CI. Os nós aparecem conforme os agentes são contratados e somem da lista viva
 * quando terminam.
 *
 * Os papéis que tocam o repositório (code, review, CI) rodam no runtime de
 * ferramentas, com a mesma aprovação humana do resto do app — a equipe executa
 * de verdade, não descreve o que faria.
 */
import "../styles/modes/agent.css";
import "../styles/modes/ship.css";
import { CrewRail, CrewView } from "../components/CrewView";
import { RailConversations } from "../components/RailConversations";
import { Surface, VBody, VCenter } from "../components/Primitives";
import { useApp } from "../lib/store";

/** Rail da aba: a equipe viva e o histórico. Nada para configurar. */
export function AgentRail() {
  return (
    <>
      <CrewRail />
      <span className="eyebrow">CONVERSAS</span>
      <RailConversations mode="agent" />
    </>
  );
}

export function AgentView() {
  const session = useApp((state) => state.session);
  const runtimeStatus = useApp((state) => state.runtimeStatus);
  const settings = useApp((state) => state.settings);
  const selection = settings.engines.agent;

  /** Mesma raiz que o Composer e a aba Code usam para as ferramentas. */
  const projectRoot = typeof window === "undefined" ? "." : window.localStorage.getItem("code.root") ?? ".";

  return (
    <Surface className="agx-view">
      <VBody>
        <VCenter>
          <CrewView
            selection={selection}
            ctx={{
              session,
              runtimeRunning: runtimeStatus.running,
              fusionPresets: settings.fusionPresets
            }}
            root={projectRoot}
          />
        </VCenter>
      </VBody>
    </Surface>
  );
}
