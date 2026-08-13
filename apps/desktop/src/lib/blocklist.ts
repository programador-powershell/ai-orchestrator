/**
 * Blocklist de domínios no cliente — camada de AVISO, não a barreira.
 *
 * A checagem que vale é a do Rust (`src-tauri/src/blocklist.rs`), feita sobre
 * a política **assinada** em cache, nas saídas que passam pelo backend:
 * pesquisa (`research_fetch`), webhook (`webhook_post`) e cada salto de
 * redirect.
 *
 * Esta cópia existe para dois casos que o Rust não alcança:
 *
 * 1. **MCP.** O cliente MCP fala por `fetch` do próprio webview, sem passar
 *    pelo Rust. Como `tauri.conf.json` está com `csp: null`, não há restrição
 *    de destino no renderer — então o bloqueio aqui é o que existe.
 * 2. **Feedback.** Avisar antes de tentar é melhor que deixar o Rust recusar
 *    e mostrar um erro genérico.
 *
 * Limite, dito com todas as letras: **isto é JavaScript no renderer**. Quem
 * tiver as ferramentas de desenvolvedor abertas contorna. Fechar o buraco de
 * verdade exige rotear o MCP pelo Rust — está registrado no README como
 * pendência, não como resolvido.
 *
 * A lógica de casamento é a MESMA do Rust, e os testes cobrem os mesmos casos
 * (inclusive a armadilha do sufixo) para os dois lados não divergirem.
 */

/** Normaliza um host: minúsculas, sem ponto final, sem porta. */
function normalize(host: string): string {
  const clean = host.trim().replace(/\.$/, "").toLowerCase();
  // IPv6 vem entre colchetes e não pode ter o `:` tratado como porta.
  if (clean.startsWith("[")) return clean;
  const cut = clean.indexOf(":");
  return cut === -1 ? clean : clean.slice(0, cut);
}

/**
 * A regra bate no host?
 *
 * `exemplo.com` pega o domínio e os subdomínios; `*.exemplo.com` pega só os
 * subdomínios. `malexemplo.com` NÃO é pego por `exemplo.com` — a comparação
 * respeita a fronteira do rótulo, senão qualquer domínio terminado igual
 * cairia junto.
 */
export function matchesDomain(rule: string, host: string): boolean {
  const alvo = normalize(host);
  const regra = normalize(rule);
  if (!regra || !alvo) return false;
  if (regra.startsWith("*.")) {
    return alvo.endsWith(`.${regra.slice(2)}`);
  }
  return alvo === regra || alvo.endsWith(`.${regra}`);
}

/** Primeira regra que bloqueia o host, ou null. */
export function blockedBy(rules: readonly string[], host: string): string | null {
  return rules.find((rule) => matchesDomain(rule, host)) ?? null;
}

/**
 * Verifica uma URL inteira. URL inválida NÃO é bloqueada aqui — quem recusa
 * URL malformada é quem vai usá-la, com mensagem própria.
 */
export function blockedUrl(rules: readonly string[], url: string): string | null {
  try {
    return blockedBy(rules, new URL(url).hostname);
  } catch {
    return null;
  }
}

/** Mensagem única, para o usuário não ver dois textos diferentes. */
export function blockedMessage(rule: string): string {
  return `domínio bloqueado pela política da empresa (regra: ${rule})`;
}
