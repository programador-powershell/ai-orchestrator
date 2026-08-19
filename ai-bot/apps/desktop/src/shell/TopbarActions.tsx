/**
 * O slot da barra superior.
 *
 * A superfície ativa NÃO desenha barra própria: ela injeta os botões dela no
 * mesmo lugar físico da barra do app, por portal. É isso que sustenta a promessa
 * de tela única — trocar de especialista muda o conteúdo da barra, não empilha
 * uma segunda barra embaixo da primeira.
 *
 * As AÇÕES do Quadro e do Tuning moram aqui embaixo, e não nas superfícies:
 * eram as duas telas sem botão nenhum na barra, e as ações delas não leem nada
 * da superfície — só o store. Nenhum botão daqui executa coisa alguma por
 * conta própria: ou escreve o comando no composer (a pessoa revisa e envia),
 * ou envia um pedido pela MESMA conversa de sempre — todo efeito continua
 * passando pelo funil de aprovação do gateway.
 */
import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Database, FlaskConical, ListPlus, RefreshCw, Zap } from "lucide-react";
import { useApp } from "../lib/store";

/** Um id, um host. Quem renderizar dois `TopbarSlot` quebra o portal em silêncio. */
const SLOT_ID = "topbar-actions";

/** O host. Vive dentro da `Topbar`, e só lá. */
export function TopbarSlot() {
  return <div id={SLOT_ID} className="topbar-actions" />;
}

export function TopbarActions({ children }: { children: ReactNode }) {
  // O host é procurado num efeito, e não no corpo do render, porque no primeiro
  // render da superfície o div do slot ainda não foi comitado no DOM. Guardar em
  // estado força o segundo render — que é quando o portal tem para onde ir.
  const [host, setHost] = useState<HTMLElement | null>(null);

  useEffect(() => {
    setHost(document.getElementById(SLOT_ID));
  }, []);

  if (!host) return null;
  return createPortal(children, host);
}

/**
 * Ações do QUADRO (especialista de trabalho). "Tarefa" e "Automação" inserem
 * o comando do especialista no composer — os mesmos /tarefa e /automacao das
 * ações rápidas dele — porque tarefa sem descrição não existe: o botão abre a
 * frase, a pessoa a termina. "Andamento" envia direto, como o "Validar" do
 * Fluxo: é pergunta pronta, sem lacuna a preencher.
 */
export function BoardTopbarActions() {
  const busy = useApp((state) => state.busy);
  const send = useApp((state) => state.send);
  const setInput = useApp((state) => state.setInput);

  // Fragmento, e não um `div.topbar-actions`: o host do portal JÁ é esse div.
  return (
    <>
      <button
        type="button"
        className="btn"
        onClick={() => setInput("/tarefa ")}
        title="Escreve /tarefa no campo de texto; descreva e envie"
      >
        <ListPlus size={13} aria-hidden />
        Tarefa
      </button>
      <button
        type="button"
        className="btn"
        onClick={() => setInput("/automacao ")}
        title="Escreve /automacao no campo de texto; diga o gatilho e a ação"
      >
        <Zap size={13} aria-hidden />
        Automação
      </button>
      <button
        type="button"
        className="btn"
        disabled={busy}
        onClick={() => send("Resuma o andamento do quadro: o que está em cada coluna, o que travou e o que falta despachar.")}
        title="Pede ao especialista o resumo do quadro — pela conversa, como tudo aqui"
      >
        <RefreshCw size={13} aria-hidden />
        Andamento
      </button>
    </>
  );
}

/**
 * Ações do TUNING. "Dataset" e "Avaliar" inserem os comandos do especialista
 * (/dataset e /avaliar) no composer; "Atualizar treinos" envia o pedido que
 * faz o modelo consultar finetune.status — cujo resultado é exatamente o que
 * esta tela desenha.
 */
export function TrainTopbarActions() {
  const busy = useApp((state) => state.busy);
  const send = useApp((state) => state.send);
  const setInput = useApp((state) => state.setInput);

  return (
    <>
      <button
        type="button"
        className="btn"
        onClick={() => setInput("/dataset ")}
        title="Escreve /dataset no campo de texto; diga o formato e a fonte"
      >
        <Database size={13} aria-hidden />
        Dataset
      </button>
      <button
        type="button"
        className="btn"
        onClick={() => setInput("/avaliar ")}
        title="Escreve /avaliar no campo de texto; diga o que comparar"
      >
        <FlaskConical size={13} aria-hidden />
        Avaliar
      </button>
      <button
        type="button"
        className="btn"
        disabled={busy}
        onClick={() => send("Atualize o estado dos treinos: consulte finetune.status e resuma o que mudou.")}
        title="Pede a consulta de finetune.status — o resultado preenche esta tela"
      >
        <RefreshCw size={13} aria-hidden />
        Atualizar treinos
      </button>
    </>
  );
}

export default TopbarActions;
