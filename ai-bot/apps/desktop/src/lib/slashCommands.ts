/**
 * Comandos de barra — expandidos NO CLIENTE, antes do transporte.
 *
 * O porquê de ser aqui e não no gateway: `/review` ia LITERAL ao modelo, e o
 * que o modelo faz com uma linha de comando solta depende do humor do modelo —
 * às vezes revisava, às vezes perguntava "review de quê?". O comando é um
 * atalho de PROMPT, não um verbo de protocolo (o único verbo de protocolo é o
 * /mode, que o gateway já trata e por isso NÃO está neste mapa — expandi-lo
 * aqui roubaria a troca de modo do supervisor).
 *
 * Comando desconhecido passa intacto: inventar expansão para /qualquercoisa
 * transformaria erro de digitação em prompt que ninguém escreveu.
 */

/** O que vem depois do comando — o alvo — entra na frase pronta. */
type Template = (alvo: string) => string;

const SEM_ALVO = "o código mais recente desta conversa (o último arquivo, diff ou bloco discutido)";

export const SLASH_COMMANDS: Record<string, Template> = {
  "/review": (alvo) =>
    `Faça uma revisão de código de ${alvo || SEM_ALVO}. ` +
    "Aponte defeitos de correção primeiro (com o cenário concreto em que quebram), depois riscos de segurança, " +
    "depois simplificações. Para cada apontamento, diga o arquivo/trecho e proponha a correção. " +
    "Se não houver problema relevante, diga isso explicitamente em vez de inventar apontamento.",
  "/explain": (alvo) =>
    `Explique ${alvo || SEM_ALVO}. ` +
    "Comece pelo propósito (o que isso resolve e para quem), depois o fluxo principal passo a passo, " +
    "e feche com as decisões não óbvias e as armadilhas que quem for mexer precisa saber. " +
    "Use os nomes reais do código ao citar funções e arquivos.",
  "/testgen": (alvo) =>
    `Escreva testes para ${alvo || SEM_ALVO}. ` +
    "Cubra o caminho feliz, os limites (vazio, nulo, máximo) e os casos de erro, seguindo o estilo e o " +
    "framework de teste que o projeto já usa — olhe os testes vizinhos antes de escolher o formato. " +
    "Cada teste com nome que descreva o comportamento, não a implementação."
};

/**
 * Expande a linha quando ela COMEÇA com um comando conhecido. O resto da linha
 * vira o alvo. Qualquer outra coisa volta como veio — inclusive `/mode`.
 */
export function expandSlashCommand(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return text;
  const space = trimmed.search(/\s/);
  const command = (space < 0 ? trimmed : trimmed.slice(0, space)).toLowerCase();
  const template = SLASH_COMMANDS[command];
  if (!template) return text;
  const alvo = space < 0 ? "" : trimmed.slice(space + 1).trim();
  return template(alvo);
}
