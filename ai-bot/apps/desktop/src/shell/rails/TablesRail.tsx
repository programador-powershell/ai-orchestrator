/**
 * Rail do especialista de Dados: o schema NAVEGÁVEL.
 *
 * Substitui o placeholder permanente do Rail.tsx (que prometia "as tabelas
 * aparecem aqui" sem nenhum caminho de código que o enchesse). O dado vem do
 * store de módulo `schemaFoco`, publicado pela SchemaSurface — o rail não
 * relê a conversa nem reparse o tool.result: uma derivação só, um dono só.
 *
 * Clicar numa tabela FOCA o cartão dela no diagrama (a superfície rola e
 * realça); clicar numa relação foca a tabela de ORIGEM — é nela que a FK mora,
 * então é lá que a pessoa vai mexer. Portado do DataRail do orquestrador
 * (DataView.tsx), sem o botão "Add table": esta tela é somente leitura, e um
 * botão que edita mentiria sobre isso.
 */
import { useState, type ReactNode } from "react";
import { AlertTriangle, Database, Link2, Search, Table2 } from "lucide-react";
import {
  problemasDoSchema,
  rotuloDaRelacao,
  useSchemaFoco,
  type Relation,
  type Table
} from "../../lib/schemaFoco";

/* ------------------------------- filtragem ------------------------------- */

/** A busca acha tabela também pelo nome de um CAMPO: quem procura "email" quer
 *  a tabela que o guarda, e raramente lembra qual é. (regra do DataRail) */
export function filtrarTabelas(tables: readonly Table[], busca: string): Table[] {
  const termo = busca.trim().toLowerCase();
  if (termo === "") return [...tables];
  return tables.filter(
    (table) =>
      table.name.toLowerCase().includes(termo) ||
      table.columns.some((column) => column.name.toLowerCase().includes(termo))
  );
}

/** A relação é buscada pelo rótulo INTEIRO (`a.x → b.y`): é o texto que está
 *  na tela, e buscar pelo que se vê é o único contrato que não surpreende. */
export function filtrarRelacoes(relations: readonly Relation[], busca: string): Relation[] {
  const termo = busca.trim().toLowerCase();
  if (termo === "") return [...relations];
  return relations.filter((relation) => rotuloDaRelacao(relation).toLowerCase().includes(termo));
}

/* --------------------------------- o rail -------------------------------- */

export function TablesRail(): ReactNode {
  const schema = useSchemaFoco((state) => state.schema);
  const tabelaFocada = useSchemaFoco((state) => state.tabelaFocada);
  const focar = useSchemaFoco((state) => state.focar);
  const [aba, setAba] = useState<"tabelas" | "relacoes">("tabelas");
  const [busca, setBusca] = useState("");

  if (schema.tables.length === 0) {
    // Mesma marcação do RailEmpty do Rail.tsx (que não é exportado — e este
    // arquivo não pode abri-lo): o vazio continua honesto, e agora ele é
    // verdade temporária, não permanente.
    return (
      <div className="rail-empty">
        <Database size={18} aria-hidden />
        <p className="rail-empty-title">Nada aqui ainda.</p>
        <p className="rail-empty-hint">
          As tabelas e relações do schema aparecem aqui quando o especialista Dados exportar um diagrama.
        </p>
      </div>
    );
  }

  const orfas = new Set(problemasDoSchema(schema.tables, schema.relations).map((relation) => relation.id));
  const tabelas = filtrarTabelas(schema.tables, busca);
  const relacoes = filtrarRelacoes(schema.relations, busca);
  const focadaMinuscula = tabelaFocada === null ? "" : tabelaFocada.toLowerCase();

  /** O clique foca a tabela pelo nome CANÔNICO do snapshot (a relação pode
   *  citar "Users" enquanto a tabela se chama "users" — o realce compara, mas
   *  o rail entrega o nome certo para o tooltip e o prompt não divergirem). */
  const focarPorNome = (nome: string): void => {
    const tabela = schema.tables.find((item) => item.name.toLowerCase() === nome.toLowerCase());
    if (tabela !== undefined) focar(tabela.name);
  };

  return (
    <>
      {/* Contador na PRÓPRIA aba: diz quanto existe do outro lado sem trocar
          de aba — o que o rótulo sozinho não faz. */}
      <div className="rail-tabs" role="tablist" aria-label="Navegar no schema">
        <button
          type="button"
          role="tab"
          aria-selected={aba === "tabelas"}
          data-active={aba === "tabelas"}
          onClick={() => setAba("tabelas")}
        >
          <Table2 size={11} aria-hidden />
          Tabelas
          <span className="rail-tab-count">{schema.tables.length}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={aba === "relacoes"}
          data-active={aba === "relacoes"}
          onClick={() => setAba("relacoes")}
        >
          <Link2 size={11} aria-hidden />
          Relações
          <span className="rail-tab-count">{schema.relations.length}</span>
        </button>
      </div>

      <label className="rail-search">
        <Search size={13} aria-hidden />
        <input
          value={busca}
          onChange={(event) => setBusca(event.target.value)}
          placeholder="Buscar no schema…"
          aria-label="Buscar no schema"
        />
      </label>

      {aba === "tabelas" ? (
        <ul className="rail-list">
          {tabelas.map((table) => (
            <li key={table.name}>
              <button
                type="button"
                className="rail-item"
                data-active={table.name.toLowerCase() === focadaMinuscula}
                title={`Focar ${table.name} no diagrama`}
                onClick={() => focar(table.name)}
              >
                <Table2 size={13} aria-hidden />
                <span className="rail-item-label">{table.name}</span>
                <span className="rail-item-meta">{table.columns.length} campos</span>
              </button>
            </li>
          ))}
          {tabelas.length === 0 ? <li className="rail-note">Nenhuma tabela bate com a busca.</li> : null}
        </ul>
      ) : (
        <ul className="rail-list">
          {relacoes.map((relation) => {
            const orfa = orfas.has(relation.id);
            const origemExiste = schema.tables.some(
              (table) => table.name.toLowerCase() === relation.from.toLowerCase()
            );
            return (
              <li key={relation.id}>
                {/* Órfã fica CLICÁVEL enquanto a tabela de origem existir: o
                    problema pode ser só a coluna, e focar a tabela é o caminho
                    para consertá-la. Sem origem não há para onde ir. */}
                <button
                  type="button"
                  className="rail-item"
                  data-orfa={orfa}
                  disabled={!origemExiste}
                  title={
                    orfa
                      ? `Relação órfã — aponta para tabela ou coluna que não veio no schema (${rotuloDaRelacao(relation)})`
                      : `Focar ${relation.from} no diagrama`
                  }
                  onClick={() => focarPorNome(relation.from)}
                >
                  {orfa ? <AlertTriangle size={13} aria-hidden /> : <Link2 size={13} aria-hidden />}
                  <span className="rail-item-label">{rotuloDaRelacao(relation)}</span>
                  <span className="rail-item-meta">{`${relation.fromCard}-${relation.toCard}`}</span>
                </button>
              </li>
            );
          })}
          {relacoes.length === 0 ? (
            <li className="rail-note">
              {schema.relations.length === 0 ? "Sem relações neste schema." : "Nenhuma relação bate com a busca."}
            </li>
          ) : null}
        </ul>
      )}
    </>
  );
}

export default TablesRail;
