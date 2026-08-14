/**
 * A pergunta do supervisor.
 *
 * Quando o supervisor não consegue decidir sozinho ele manda `ask` e PARA: o
 * turno fica parado do outro lado até chegar o `reply`. Por isso este cartão
 * cobre a tela igual ao de aprovação — uma pergunta que se pudesse ignorar
 * deixaria o orbe girando até o timeout, e a pessoa jamais saberia que era ela
 * quem estava segurando a resposta.
 *
 * O formato visual é o mesmo do `ApprovalCard` de propósito (as classes
 * `.approval-backdrop`/`.approval-card` são as dele): as duas são interrupções
 * do mesmo tipo — o app parou e precisa de uma decisão humana — e ensinar dois
 * formatos para a mesma coisa só faria a segunda parecer menos séria.
 *
 * Diferença de conteúdo, e não de estilo: aqui não há prazo. Recusar por
 * silêncio faz sentido para uma ferramenta que quer mexer na máquina; para uma
 * pergunta, um "não respondeu" inventaria uma resposta que ninguém deu.
 */
import { useEffect, useState, type FormEvent } from "react";
import { CornerDownLeft, MessageCircleQuestion } from "lucide-react";
import { useApp } from "../lib/store";

export function AskCard() {
  const ask = useApp((state) => state.pendingAsk);
  const answerAsk = useApp((state) => state.answerAsk);

  const [draft, setDraft] = useState("");

  const askId = ask?.askId ?? "";

  useEffect(() => {
    // Pergunta nova, campo limpo: aproveitar o texto da anterior mandaria para o
    // supervisor uma resposta escrita para outra pergunta.
    setDraft("");
  }, [askId]);

  if (!ask) return null;

  // `options` vazio é a pergunta ABERTA. Ter as duas formas no mesmo cartão é o
  // que o protocolo permite, e forçar texto livre onde havia opções faria a
  // pessoa digitar à mão um valor que o supervisor já tinha enumerado.
  const options = ask.options ?? [];
  const trimmed = draft.trim();

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = draft.trim();
    if (value === "") return;
    answerAsk(value);
  }

  return (
    <div className="approval-backdrop">
      <section
        className="approval-card"
        role="alertdialog"
        aria-labelledby="ask-title"
        aria-describedby="ask-question"
      >
        <header className="approval-head">
          <MessageCircleQuestion size={16} aria-hidden />
          <h2 id="ask-title" className="approval-tool">
            pergunta
          </h2>
        </header>

        <p id="ask-question" className="approval-summary">
          {ask.question}
        </p>

        <p className="approval-note">
          {ask.blocking
            ? "A resposta está parada esperando isto — o supervisor só continua depois que você responder."
            : "O supervisor segue trabalhando; a resposta entra assim que você mandar."}
        </p>

        {options.length > 0 ? (
          <footer className="approval-actions">
            {options.map((option) => (
              <button
                key={option}
                type="button"
                className="button-secondary"
                onClick={() => answerAsk(option)}
              >
                {option}
              </button>
            ))}
          </footer>
        ) : (
          <form className="approval-actions" onSubmit={submit}>
            <label className="visually-hidden" htmlFor="ask-answer">
              Resposta
            </label>
            {/* O campo cresce dentro da linha de ações (que é um flex) em vez de
                ficar na largura padrão do input, de vinte caracteres. É a única
                medida daqui: o resto do cartão é o CSS do pedido de aprovação. */}
            <input
              id="ask-answer"
              type="text"
              value={draft}
              autoFocus
              autoComplete="off"
              placeholder="Responda aqui…"
              style={{ flex: 1, minWidth: 0 }}
              onChange={(event) => setDraft(event.target.value)}
            />
            <button type="submit" className="button-primary" disabled={trimmed === ""}>
              <CornerDownLeft size={14} aria-hidden />
              Responder
            </button>
          </form>
        )}
      </section>
    </div>
  );
}

export default AskCard;
