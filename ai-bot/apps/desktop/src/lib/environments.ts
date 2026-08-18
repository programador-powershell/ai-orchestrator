/**
 * O catálogo de reserva dos ambientes e o mapa de ícones.
 *
 * Mesma divisão de trabalho dos especialistas (ver `specialists.ts`): quem sabe
 * o que existe NESTA máquina é o gateway — ele é quem procura o Docker, a
 * distro do WSL e a VPS cadastrada —, e quem sabe desenhar é o cliente. O
 * catálogo daqui existe porque o rodapé precisa de rótulo e ícone ANTES do
 * `ready` chegar, e um rodapé vazio no primeiro quadro parece defeito.
 *
 * A diferença para os especialistas: aqui a reserva marca tudo que não é local
 * como INDISPONÍVEL. Não é pessimismo — é a única resposta honesta enquanto
 * ninguém mediu nada. Oferecer "Docker" antes de saber se há Docker é prometer
 * uma execução que vai falhar depois, e o preço do engano é o comando cair na
 * estação da pessoa em vez do contêiner.
 */

import { Cloud, Container, Monitor, Server, Terminal, type LucideIcon } from "lucide-react";
import type { Environment, EnvironmentInfo } from "@ai-bot/contracts";

/** Onde o comando cai quando ninguém escolheu nada. */
export const DEFAULT_ENVIRONMENT: Environment = "local";

/** Enquanto o gateway não respondeu quais ambientes existem nesta máquina. */
const UNMEASURED = "o gateway ainda não confirmou este ambiente nesta máquina";

/**
 * Rótulo e dica acompanham os do gateway
 * (`internal/sandbox/sandbox.go`) de propósito: o texto troca no primeiro
 * `ready`, e duas redações diferentes fariam o menu piscar outra frase meio
 * segundo depois de abrir.
 */
export const FALLBACK_ENVIRONMENTS: EnvironmentInfo[] = [
  {
    id: "local",
    label: "Local",
    hint: "No seu computador",
    available: true
  },
  {
    id: "docker",
    label: "Docker",
    hint: "Sandbox do Docker (sbx), isolado do seu disco",
    available: false,
    detail: UNMEASURED
  },
  {
    id: "wsl",
    label: "WSL",
    hint: "Subsistema Linux no Windows",
    available: false,
    detail: UNMEASURED
  },
  {
    id: "vps",
    label: "VPS",
    hint: "Servidor configurado pela TI",
    available: false,
    detail: UNMEASURED
  },
  {
    id: "cloud",
    label: "Nuvem",
    hint: "GitHub, GitLab, Gitea…",
    available: false,
    detail: UNMEASURED
  }
];

/**
 * Um ícone por ambiente. São cinco desenhos bem diferentes de propósito: o
 * rodapé tem 22px de altura e o ícone é o que se lê antes do texto.
 */
export const ENVIRONMENT_ICON: Record<Environment, LucideIcon> = {
  local: Monitor,
  docker: Container,
  wsl: Terminal,
  vps: Server,
  cloud: Cloud
};

/**
 * Nunca devolve `undefined`.
 *
 * Está no caminho de renderização do rodapé, que desenha a cada quadro: um
 * ambiente desconhecido (gateway mais novo que o app) vira uma entrada com o
 * próprio id no rótulo em vez de derrubar a barra inteira.
 */
export function environmentInfo(list: EnvironmentInfo[], id: Environment): EnvironmentInfo {
  const found = list.find((item) => item.id === id);
  if (found) return found;
  const reserve = FALLBACK_ENVIRONMENTS.find((item) => item.id === id);
  if (reserve) return reserve;
  return { id, label: id, hint: "ambiente que este cliente ainda não conhece", available: false };
}

/** Quando o gateway não disse por que o ambiente não serve. */
const NO_REASON = "o gateway não disse o motivo";

/**
 * A dica do crachá do rodapé.
 *
 * O crachá já escreve "indisponível" em vermelho quando o ambiente em vigor
 * deixou de existir — mas só a palavra, e a palavra sozinha não diz o que
 * fazer. O `detail` é a frase acionável que o gateway mediu nesta máquina ("o
 * Docker Sandboxes não está instalado — instale o Docker Desktop e o sbx…"), e
 * ela existe justamente para ser lida: no menu ela já aparece, no crachá não
 * aparecia em lugar nenhum.
 */
export function environmentTitle(info: EnvironmentInfo): string {
  const head = `o próximo comando roda em: ${info.label} — ${info.hint}`;
  if (info.available) return head;
  return `${head} (indisponível: ${info.detail ?? NO_REASON})`;
}
