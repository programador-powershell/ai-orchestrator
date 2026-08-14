/**
 * O popup da delegação — o bot que sai e o bot que entra.
 *
 * Quando um especialista chama outro no meio do próprio turno, a resposta passa
 * a vir de outra pessoa. Sem mostrar a troca, o tom muda no meio do fio e
 * ninguém entende por quê; é o mesmo motivo da faixa de "agora é <Nome>" na
 * conversa, só que aqui a troca acontece DENTRO de um turno já em andamento.
 *
 * NÃO EXISTE BOTÃO DE APROVAR AQUI, e a ausência é deliberada: a delegação não
 * pede permissão. Escolher de quem é o assunto é decisão do bot — pedir
 * autorização para isso seria pedir que a pessoa faça o roteamento que o
 * produto promete fazer por ela. A FRONTEIRA fica um passo adiante: o que o
 * delegado FAZ continua passando pelo portão de aprovação de sempre. Cada
 * ferramenta dele emite `approval.request` e para, exatamente como se fosse o
 * especialista original — delegar não herda permissão nem amplia escopo.
 *
 * Acessibilidade: é um `role="status"` com `aria-live="polite"`, não um
 * diálogo. Não rouba foco, não tem armadilha de foco, não bloqueia a tela — a
 * conversa continua rolando atrás, e quem lê com leitor de tela ouve o aviso ao
 * terminar a frase corrente, em vez de ser interrompido.
 */

import { useEffect, useState } from "react";
import { Check, MoveRight } from "lucide-react";
import type { Delegate } from "@aibot/contracts";
import { BotAvatar } from "../avatar/BotAvatar";
import { hueStyle, specialistById } from "../lib/specialists";
import { useApp } from "../lib/store";

/**
 * Quanto o cartão fica de pé depois de concluído.
 *
 * Curto o bastante para não virar entulho sobre a resposta que já voltou a
 * rolar, longo o bastante para o olho registrar que aquilo terminou. Some
 * sozinho porque não há nada a decidir: um botão de fechar pediria uma ação por
 * um aviso que já cumpriu a função.
 */
const DISMISS_MS = 1200;

/**
 * A chave de UMA delegação.
 *
 * A delegação não tem id (ver o contrato), então a chave é a posição na lista
 * mais o par de bots: a posição sozinha reciclaria o cartão entre delegações
 * diferentes — e cartão reciclado é animação que não recomeça.
 */
function delegationKey(list: Delegate[]): string {
  const index = list.length - 1;
  const last = list[index];
  if (!last) return "";
  return `${index}:${last.from}>${last.to}`;
}

/**
 * O cartão. É componente de topo, e não uma função declarada dentro do popup,
 * porque a identidade do tipo é o que o React usa para decidir entre remontar e
 * atualizar: declarado lá dentro, ele seria um tipo NOVO a cada render e a
 * animação recomeçaria a cada delta que chega da conversa.
 */
function DelegationCard({ delegation }: { delegation: Delegate }) {
  const specialists = useApp((state) => state.specialists);
  const avatars = useApp((state) => state.avatars);

  const from = specialistById(specialists, delegation.from);
  const to = specialistById(specialists, delegation.to);
  const done = delegation.done === true;

  return (
    <div
      className="delegation"
      data-done={done ? "true" : "false"}
      // A matiz é a de QUEM ENTROU: é o acento do app acompanhando a troca de
      // dono. O `data-hue` não é decoração — é ele que faz tokens.css REFAZER
      // as derivadas (`--accent`, `--accent-soft`…) a partir da matiz nova;
      // sem ele, o `--accent-h` inline não mudaria cor nenhuma. E não animar
      // `--accent-h`: custom property não interpola, e a transição encalha.
      data-hue={to.id}
      style={hueStyle(to.hue)}
      title={delegation.result ?? delegation.reason}
    >
      {/* Os retratos são decoração: quem os descreve é a frase abaixo, e
          repetir o nome aqui faria o leitor de tela dizer tudo duas vezes. */}
      <div className="delegation-cast" aria-hidden="true">
        <span className="delegation-out" data-hue={from.id} style={hueStyle(from.hue)}>
          <BotAvatar avatar={avatars[from.id] ?? from.avatar} size={38} />
        </span>
        <span className="delegation-arrow">
          <MoveRight size={14} />
        </span>
        <span className="delegation-in">
          <BotAvatar avatar={avatars[to.id] ?? to.avatar} size={64} />
        </span>
      </div>

      <div className="delegation-body">
        <p className="delegation-line">
          o <b>{from.name}</b> chamou o <b>{to.name}</b>
          {done ? (
            <span className="delegation-done">
              <Check size={12} aria-hidden /> concluído
            </span>
          ) : null}
        </p>
        <p className="delegation-goal">{delegation.goal}</p>
        {/* O nível só aparece quando há mais de um: "nível 1" em toda delegação
            seria ruído, e número inventado é pior que ausência. */}
        {delegation.depth > 1 ? (
          <p className="delegation-depth">delegação em nível {delegation.depth}</p>
        ) : null}
      </div>
    </div>
  );
}

export function DelegationPopup() {
  const delegations = useApp((state) => state.delegations);

  /** A delegação já dispensada — guardada por CHAVE, não por booleano: uma
   *  delegação nova precisa aparecer mesmo depois de a anterior ter sumido. */
  const [dismissed, setDismissed] = useState("");

  const current = delegations.length > 0 ? delegations[delegations.length - 1] : undefined;
  const key = delegationKey(delegations);
  const done = current?.done === true;

  useEffect(() => {
    if (key === "" || !done) return;
    const timer = setTimeout(() => setDismissed(key), DISMISS_MS);
    // O relógio morre com o efeito: uma delegação nova entrando antes do prazo
    // levaria o cartão dela embora junto com o da anterior.
    return () => clearTimeout(timer);
  }, [key, done]);

  // A camada fica montada mesmo vazia: um `aria-live` que nasce junto com o
  // conteúdo costuma não ser anunciado — a região precisa existir ANTES de
  // mudar. Vazia ela não ocupa espaço nem intercepta clique (ver o CSS).
  return (
    <div className="delegation-layer" role="status" aria-live="polite">
      {current && dismissed !== key ? <DelegationCard key={key} delegation={current} /> : null}
    </div>
  );
}

export default DelegationPopup;
