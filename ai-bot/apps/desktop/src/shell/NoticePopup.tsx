/**
 * O popup do aviso de execução — o bot contando ONDE o próximo passo vai rodar.
 *
 * Nasceu para o Docker: quando o supervisor decide que um comando vai para um
 * container (ou que, sem o sbx, ele cai no ai-jail da VPS), o aviso chega como
 * `notice` ANTES de a execução começar. Sem este popup, a decisão seria
 * exatamente o tipo de silêncio de execução que o seletor de ambiente existe
 * para acabar — o comando rodando num lugar que ninguém viu ser escolhido.
 *
 * REUSA o visual do DelegationPopup de propósito (mesmas classes, mesmas
 * animações de shell.css): os dois são "o bot está te contando uma coisa", e
 * uma segunda linguagem visual para a mesma frase faria a segunda parecer
 * defeito. O avatar do especialista ativo desliza (`delegation-in`) com o
 * contêiner desenhado ao lado; com `prefers-reduced-motion` o CSS já tira o
 * movimento e o ícone decorativo, sobrando avatar e texto — que é o que o
 * aviso precisa dizer.
 *
 * NÃO HÁ BOTÃO, e a ausência é deliberada: o aviso não pede decisão (quem pede
 * é o portão de aprovação, que continua valendo para a ferramenta). Ele some
 * sozinho após ~4 s — e o TIMER MORA AQUI, não no store: o store é puro, sem
 * relógio, e é isso que o mantém testável. O componente guarda qual índice já
 * dispensou; a fila `notices` do store só cresce e zera com a conversa.
 *
 * Acessibilidade: `role="status"` + `aria-live="polite"`, como a delegação —
 * não rouba foco, não bloqueia a tela, e o leitor de tela anuncia ao terminar
 * a frase corrente.
 */

import { useEffect, useState, type CSSProperties } from "react";
import { Box, Container, Megaphone } from "lucide-react";
import type { Notice } from "@aibot/contracts";
import { BotAvatar } from "../avatar/BotAvatar";
import { hueStyle, specialistById } from "../lib/specialists";
import { useApp } from "../lib/store";

/**
 * Os dois relógios do cartão. SETTLE_MS liga o `data-done`, que dispara a
 * animação de saída do CSS (ela tem 900ms de atraso próprio — ver shell.css);
 * DISMISS_MS desmonta o cartão depois que ela terminou. Somados, ~4 s de tela.
 */
const SETTLE_MS = 3000;
const DISMISS_MS = 4200;

/**
 * O desenho do aviso. "docker" é o contrato de hoje (ícone Container do
 * lucide); um ícone desconhecido de um gateway mais novo cai no megafone em
 * vez de quebrar o popup.
 */
function noticeGlyph(icon: string) {
  switch (icon) {
    case "docker":
      return Container;
    case "sandbox":
      // O aviso de DEGRADAÇÃO da jaula ("sem sandbox: …") chega com este
      // ícone e continua popup — o gesto liberado ("no sandbox: …") nem passa
      // por aqui: o store o desvia para o chip da conversa.
      return Box;
    default:
      return Megaphone;
  }
}

/**
 * Um degrau abaixo da camada de delegação: os dois avisos podem coexistir no
 * mesmo turno (delegar E anunciar container), e duas camadas no MESMO topo
 * desenhariam um cartão exatamente em cima do outro. Inline, e não em CSS
 * novo, porque é a única coisa que este popup NÃO herda da delegação.
 */
const LAYER_OFFSET: CSSProperties = {
  top: "calc(var(--topbar-h) + var(--shell-pad) + var(--shell-gap) + 118px)"
};

/**
 * O cartão. Componente de topo pelo mesmo motivo do DelegationCard: declarado
 * dentro do popup ele seria um TIPO novo a cada render, e o React remontaria o
 * cartão (e recomeçaria a animação) a cada delta que chega da conversa.
 */
function NoticeCard({ notice, done }: { notice: Notice; done: boolean }) {
  const specialists = useApp((state) => state.specialists);
  const avatars = useApp((state) => state.avatars);

  // O especialista ativo veio no próprio aviso — o popup não deduz do estado
  // da tela, que pode já ter trocado. Id vazio ou desconhecido cai no padrão.
  const specialist = specialistById(specialists, notice.specialist ?? "");
  const Glyph = noticeGlyph(notice.icon);

  return (
    <div
      className="delegation"
      data-done={done ? "true" : "false"}
      // A matiz é a do especialista que vai executar — o `data-hue` refaz as
      // derivadas do acento (ver tokens.css); sem ele o estilo inline não
      // mudaria cor nenhuma. E não animar `--accent-h`: custom property não
      // interpola, e a transição encalha.
      data-hue={specialist.id}
      style={hueStyle(specialist.hue)}
      title={notice.detail ?? notice.title}
    >
      {/* Decoração: quem carrega o sentido é o texto ao lado — repetir aqui
          faria o leitor de tela dizer tudo duas vezes. Em reduced-motion o
          CSS esconde o glifo e mantém avatar + texto. */}
      <div className="delegation-cast" aria-hidden="true">
        <span className="delegation-arrow">
          <Glyph size={22} />
        </span>
        <span className="delegation-in">
          <BotAvatar avatar={avatars[specialist.id] ?? specialist.avatar} size={64} />
        </span>
      </div>

      <div className="delegation-body">
        <p className="delegation-line">
          <b>{notice.title}</b>
        </p>
        {notice.detail ? <p className="delegation-goal">{notice.detail}</p> : null}
      </div>
    </div>
  );
}

export function NoticePopup() {
  const notices = useApp((state) => state.notices);

  /** Índices já resolvidos — por ÍNDICE, não booleano: a fila só cresce, então
   *  o índice identifica o aviso, e um novo precisa aparecer mesmo depois de o
   *  anterior ter sumido. */
  const [dismissed, setDismissed] = useState(-1);
  const [settled, setSettled] = useState(-1);

  const index = notices.length - 1;
  const current = index >= 0 ? notices[index] : undefined;

  useEffect(() => {
    if (index < 0) return;
    const settle = setTimeout(() => setSettled(index), SETTLE_MS);
    const dismiss = setTimeout(() => setDismissed(index), DISMISS_MS);
    // Os relógios morrem com o efeito: um aviso novo entrando antes do prazo
    // não pode levar o cartão dele embora junto com o do anterior.
    return () => {
      clearTimeout(settle);
      clearTimeout(dismiss);
    };
  }, [index]);

  // A camada fica montada mesmo vazia: um `aria-live` que nasce junto com o
  // conteúdo costuma não ser anunciado — a região precisa existir ANTES de
  // mudar. Vazia ela não ocupa espaço nem intercepta clique (ver o CSS).
  return (
    <div className="delegation-layer" style={LAYER_OFFSET} role="status" aria-live="polite">
      {current && dismissed !== index ? (
        <NoticeCard key={index} notice={current} done={settled === index} />
      ) : null}
    </div>
  );
}

export default NoticePopup;
