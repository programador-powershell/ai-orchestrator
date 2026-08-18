/**
 * GrokAvatar — a ponte React do wrapper `grok_professional_avatar_v3.ts` (motor Grok metaball rig v7).
 *
 * O wrapper monta o avatar de um MÓDULO carregado por URL — a interface do
 * export JavaScript do Bible Strong Avatar Lab (`createAvatar` +
 * `availableAnimations`). Hoje a URL aponta para o stand-in próprio em
 * `public/avatars/grok-avatar.js`; quando o pacote real exportado do Lab for
 * aprovado (TI/SI — o Lab é AGPL), basta substituir aquele arquivo. Nada aqui
 * muda.
 *
 * A montagem é assíncrona (import dinâmico do módulo): o efeito guarda a
 * PROMESSA e o cleanup destrói o controller mesmo quando o desmonte vence a
 * montagem — sem isso o StrictMode (monta-desmonta-monta) vazaria um avatar
 * órfão no DOM.
 */

import { useEffect, useRef } from "react";

import {
  mountProfessionalGrokAvatar,
  type Specialist as GrokSpecialist,
  type ProfessionalGrokController as GrokSpecialistAvatarController,
  type SpecialistState as GrokSpecialistState
} from "./grok_professional_avatar_v3";

export type { GrokSpecialist, GrokSpecialistState };

/**
 * URL do módulo de avatar — o stand-in em `public/avatars/`, substituível pelo
 * export real do Lab. ABSOLUTA de propósito: o dev server do Vite recusa
 * import de `/public` por caminho relativo ("should not be imported from
 * source code"), mas uma URL com origin passa reta para o import nativo do
 * navegador — em dev, no build e no asset protocol do Tauri.
 */
const LAB_MODULE_URL =
  typeof window === "undefined"
    ? "/avatars/grok-avatar.js"
    : new URL("/avatars/grok-avatar.js", window.location.origin).href;

/**
 * O catálogo do AI-BOT tem onze ids; o wrapper conhece oito. O mapa aproxima
 * os que faltam pelo ofício mais próximo — office conversa com documentos,
 * work é o pipeline de tarefas, master coordena a rede como o agent.
 */
const ESPECIALISTA_GROK: Record<string, GrokSpecialist> = {
  chat: "chat",
  code: "code",
  data: "data",
  design: "design",
  agent: "agent",
  fluxo: "flow",
  flow: "flow",
  tune: "tuning",
  tuning: "tuning",
  security: "security",
  office: "chat",
  work: "flow",
  master: "agent"
};

export function grokSpecialistOf(id: string): GrokSpecialist {
  return ESPECIALISTA_GROK[id] ?? "agent";
}

/** Rótulos dos estados para legendas do trilho (o wrapper não os exporta). */
export const GROK_STATE_LABELS: Record<GrokSpecialistState, string> = {
  active: "Ativo",
  owner: "Owner",
  working: "Trabalhando",
  waiting: "Em espera",
  completed: "Concluído"
};

export function GrokAvatar({
  specialist,
  state = "active",
  size = 220,
  className,
  title
}: {
  specialist: GrokSpecialist;
  state?: GrokSpecialistState;
  size?: number | string;
  className?: string;
  title?: string;
}) {
  const hostRef = useRef<HTMLSpanElement>(null);
  const controllerRef = useRef<GrokSpecialistAvatarController | null>(null);

  // Monta UMA vez; trocas de prop passam pelos métodos do controller (é a
  // troca de animação do Lab que faz a transição, não um re-mount). O ref de
  // props cobre a janela da montagem assíncrona: se especialista/estado
  // mudarem enquanto o módulo carrega, o controller nasce e é sincronizado
  // com o valor ATUAL, não com o do primeiro render.
  const propsRef = useRef({ specialist, state });
  propsRef.current = { specialist, state };
  const tamanhoInicialRef = useRef(size);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let vivo = true;
    const tamanho = tamanhoInicialRef.current;
    const tamanhoNumerico = typeof tamanho === "number" ? tamanho : 124;
    const montagem = mountProfessionalGrokAvatar(host, {
      moduleUrl: LAB_MODULE_URL,
      specialist: propsRef.current.specialist,
      state: propsRef.current.state,
      size: tamanho,
      deformation: tamanhoNumerico >= 150 ? 1.0 : 0.88,
      organicWarp: false,
      statusCues: true
    });
    montagem.then(
      (controller) => {
        if (!vivo) {
          controller.destroy();
          return;
        }
        controllerRef.current = controller;
        controller.setSpecialist(propsRef.current.specialist);
        controller.setState(propsRef.current.state);
      },
      (erro: unknown) => {
        // Sem módulo não há avatar — o erro fica visível para quem depura e o
        // host fica vazio em vez de derrubar o trilho inteiro.
        console.error("avatar do especialista não montou:", erro);
      }
    );
    return () => {
      vivo = false;
      controllerRef.current?.destroy();
      controllerRef.current = null;
    };
  }, []);

  useEffect(() => {
    controllerRef.current?.setSpecialist(specialist);
  }, [specialist]);

  useEffect(() => {
    controllerRef.current?.setState(state);
  }, [state]);

  return (
    <span
      ref={hostRef}
      className={className ? `grok-host ${className}` : "grok-host"}
      style={{ display: "inline-grid", placeItems: "center", width: size, height: size, flex: "none" }}
      title={title}
    />
  );
}
