/**
 * Rail do especialista de Design: as CAMADAS do canvas, navegáveis e editáveis.
 *
 * Substitui o placeholder permanente do Rail.tsx (que prometia "as camadas
 * aparecem aqui" sem nenhum caminho de código que o enchesse). O dado vem do
 * store de módulo `useCanvasStudio`, que mora na CanvasSurface — o DONO do
 * documento é a superfície, e o rail lê o mesmo singleton e aciona as mesmas
 * ações; nenhuma segunda verdade. É o desenho do DesignRail do orquestrador
 * (modes/DesignView.tsx: rail e view no mesmo store), com o rail num arquivo
 * próprio porque no AI-BOT quem o monta é o Rail.tsx, não a superfície.
 *
 * A lista mostra o TOPO primeiro (fim do array = mais ao topo, contrato do
 * reorder do canvasDoc): é a ordem em que o olho procura — o que está por cima
 * na tela está por cima na lista. Reordenar é por botões subir/descer, não por
 * arrasto: o rail tem 236px e o arrasto brigaria com o scroll da própria
 * lista; dois botões fazem o mesmo trabalho sem gesto ambíguo.
 *
 * Os STENCILS moram aqui (e não na barra de ferramentas) pelo mesmo motivo do
 * orquestrador: um botão não é "retângulo + texto que você alinha na mão" — é
 * um item que nasce pronto e sempre igual, e a paleta de itens prontos é
 * conteúdo do trilho do ofício.
 */
import type { ReactNode } from "react";
import { ChevronDown, ChevronUp, Layers, Trash2 } from "lucide-react";
import { STENCILS } from "../../lib/canvas";
import { nodeIcon, nodeLabel, useCanvasStudio } from "../../specialists/CanvasSurface";

/** Os grupos na ordem da paleta — a MESMA ordem do módulo de stencils. */
const GRUPOS = ["Formulário", "Layout", "Fluxograma"] as const;

export function LayersRail(): ReactNode {
  const doc = useCanvasStudio((state) => state.doc);
  const selectedId = useCanvasStudio((state) => state.selectedId);
  const selecionar = useCanvasStudio((state) => state.selecionar);
  const excluirNo = useCanvasStudio((state) => state.excluirNo);
  const reordenar = useCanvasStudio((state) => state.reordenar);
  const inserirStencil = useCanvasStudio((state) => state.inserirStencil);

  // Topo primeiro: o índice REAL no doc é reconstruído a partir da posição
  // invertida — é ele que o reorder entende (maior índice = mais ao topo).
  const doTopo = [...doc.nodes].reverse();
  const topo = doc.nodes.length - 1;

  return (
    <>
      <span className="eyebrow">Stencils</span>
      {GRUPOS.map((grupo) => (
        <div className="rail-stencil-group" key={grupo}>
          <small>{grupo}</small>
          <div className="rail-stencils">
            {STENCILS.filter((spec) => spec.group === grupo).map((spec) => (
              <button
                key={spec.id}
                type="button"
                className="rail-stencil"
                title={`Inserir ${spec.label} (${spec.w}×${spec.h})`}
                onClick={() => inserirStencil(spec.id)}
              >
                {spec.label}
              </button>
            ))}
          </div>
        </div>
      ))}

      <span className="eyebrow">Camadas · {doc.nodes.length}</span>
      {doc.nodes.length === 0 ? (
        // Mesma marcação do RailEmpty do Rail.tsx (que não é exportado — e este
        // arquivo não pode abri-lo): o vazio continua honesto, e agora ele é
        // verdade temporária, não permanente.
        <div className="rail-empty">
          <Layers size={18} aria-hidden />
          <p className="rail-empty-title">Nada aqui ainda.</p>
          <p className="rail-empty-hint">
            Canvas vazio — escolha uma ferramenta (F frame · R retângulo · O elipse · T texto) e arraste na tela do
            Design, ou insira um stencil acima.
          </p>
        </div>
      ) : (
        <ul className="rail-list">
          {doTopo.map((node, posicao) => {
            const index = topo - posicao;
            return (
              // Os botões de ordem/exclusão são IRMÃOS do botão da camada, não
              // filhos: botão dentro de botão é HTML inválido e o clique dos
              // dois brigaria (mesma regra do rail-item-fork das conversas).
              <li key={node.id} className="rail-item-row rail-layer">
                <button
                  type="button"
                  className="rail-item"
                  data-active={selectedId === node.id}
                  title={`Selecionar ${nodeLabel(node)} no canvas`}
                  onClick={() => selecionar(node.id)}
                >
                  {nodeIcon(node.type)}
                  <span className="rail-item-label">{nodeLabel(node)}</span>
                  <span className="rail-item-meta">{node.type}</span>
                </button>
                <span className="rail-layer-actions">
                  <button
                    type="button"
                    className="rail-layer-btn"
                    disabled={index === topo}
                    title="Subir uma camada"
                    aria-label={`Subir ${nodeLabel(node)}`}
                    onClick={() => reordenar(node.id, index + 1)}
                  >
                    <ChevronUp size={12} />
                  </button>
                  <button
                    type="button"
                    className="rail-layer-btn"
                    disabled={index === 0}
                    title="Descer uma camada"
                    aria-label={`Descer ${nodeLabel(node)}`}
                    onClick={() => reordenar(node.id, index - 1)}
                  >
                    <ChevronDown size={12} />
                  </button>
                  <button
                    type="button"
                    className="rail-layer-btn"
                    title="Excluir camada"
                    aria-label={`Excluir ${nodeLabel(node)}`}
                    onClick={() => excluirNo(node.id)}
                  >
                    <Trash2 size={12} />
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

export default LayersRail;
