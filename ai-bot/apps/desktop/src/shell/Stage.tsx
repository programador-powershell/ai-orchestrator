/**
 * O palco.
 *
 * Uma superfície por vez, escolhida pelo `activeSurface` do store — que por sua
 * vez vem da rota decidida pelo master. Cada superfície é `lazy`: o app abre sem
 * carregar o editor, o canvas e o treinador de modelo que talvez nunca sejam
 * usados naquela sessão.
 */
import {
  Suspense,
  lazy,
  type ComponentType,
  type LazyExoticComponent
} from "react";
import { Loader2 } from "lucide-react";
import type { Surface } from "@aibot/contracts";
import { useApp } from "../lib/store";

/**
 * Aceita `export default` OU `export function <Nome>`. As superfícies são
 * escritas em paralelo por gente diferente; travar num estilo de export faria a
 * tela inteira cair por causa de uma palavra-chave a mais ou a menos.
 */
function lazySurface(
  name: string,
  load: () => Promise<unknown>
): LazyExoticComponent<ComponentType> {
  return lazy(async () => {
    const mod = (await load()) as Record<string, unknown>;
    const found = (mod.default ?? mod[name]) as ComponentType | undefined;
    if (found === undefined || found === null) {
      throw new Error(`A superfície ${name} não exporta um componente React.`);
    }
    return { default: found };
  });
}

// O import precisa ser literal em cada entrada: o Vite lê o caminho estaticamente
// para gerar o chunk, e um caminho montado em variável não vira chunk nenhum.
const SURFACE_COMPONENTS: Record<Surface, LazyExoticComponent<ComponentType>> = {
  conversation: lazySurface("ConversationSurface", () => import("../specialists/ConversationSurface")),
  // A variante `.terminal` é a superfície inteira MAIS o TerminalDock da
  // pessoa no pé — o caminho sem portão do teclado, ver EditorSurface.terminal.
  editor: lazySurface("EditorSurface", () => import("../specialists/EditorSurface.terminal")),
  document: lazySurface("DocumentSurface", () => import("../specialists/DocumentSurface")),
  canvas: lazySurface("CanvasSurface", () => import("../specialists/CanvasSurface")),
  schema: lazySurface("SchemaSurface", () => import("../specialists/SchemaSurface")),
  board: lazySurface("BoardSurface", () => import("../specialists/BoardSurface")),
  findings: lazySurface("FindingsSurface", () => import("../specialists/FindingsSurface")),
  crew: lazySurface("CrewSurface", () => import("../specialists/CrewSurface")),
  flow: lazySurface("FlowSurface", () => import("../specialists/FlowSurface")),
  train: lazySurface("TrainSurface", () => import("../specialists/TrainSurface"))
};

function StageLoading() {
  return (
    <div className="stage-loading" role="status">
      <Loader2 size={16} className="spin" aria-hidden />
      <span>Abrindo a superfície…</span>
    </div>
  );
}

export function Stage() {
  const surface = useApp((state) => state.activeSurface);
  const Surface = SURFACE_COMPONENTS[surface] as LazyExoticComponent<ComponentType> | undefined;

  if (!Surface) {
    // Superfície fora do mapa é bug de contrato, não estado normal: diz o nome em
    // vez de cair numa tela branca que ninguém sabe explicar depois.
    return (
      <section className="stage stage-unknown" data-surface={surface}>
        <p>Não existe superfície para “{String(surface)}”.</p>
        <p className="stage-hint">O gateway roteou para uma tela que este cliente ainda não conhece.</p>
      </section>
    );
  }

  return (
    // `data-surface` é o gancho de CSS da superfície; a barra superior dela chega
    // aqui por portal (ver `TopbarActions`), então o palco não desenha barra.
    <section className="stage" data-surface={surface}>
      {/* A key remonta o subtree ao trocar de superfície: sem isso o Suspense
          reaproveita o estado da superfície anterior e os botões injetados na
          barra superior ficam pendurados de um dono que já saiu de cena. */}
      <Suspense key={surface} fallback={<StageLoading />}>
        <Surface />
      </Suspense>
    </section>
  );
}

export default Stage;
