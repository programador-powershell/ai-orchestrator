/**
 * Benchmark do CAMINHO QUENTE da interface: o markdown que roda a cada token.
 *
 * Por que este arquivo fica no repositório: o custo do streaming não aparece em
 * teste de correção — a árvore continua certa enquanto o app engasga. Uma
 * regressão que ninguém mede volta, e volta calada. Aqui ela vira número.
 *
 * Os dois cenários medem coisas diferentes de propósito:
 *
 *  - "resposta longa parseada uma vez" é o piso: o custo irredutível de ler 8 KB
 *    de markdown. Nenhuma otimização de streaming pode ficar abaixo dele.
 *  - "streaming de 800 pedaços" é o teto do defeito: reparsear o acumulado a
 *    cada fatia é O(m²) no tamanho da resposta. É o cenário que corresponde ao
 *    que a pessoa vê enquanto o modelo escreve.
 *
 * A carga é REALISTA: ~8 KB, que é o tamanho de uma resposta de modelo de
 * verdade, com título, blocos de código, listas e ênfase — não um lorem ipsum
 * plano, que subestimaria o parser justamente nas construções caras.
 */

import { bench, describe } from "vitest";
import { createMarkdownStream, renderMarkdown } from "./markdown";

/* --------------------------------- a carga -------------------------------- */

const INTRO = `# Refatoração do serviço de autenticação

O serviço hoje mistura **três responsabilidades** no mesmo módulo: validação de
credencial, emissão de token e o *cache* de sessão. A separação abaixo mantém a
API pública intacta — quem chama \`authenticate()\` não percebe a mudança.

## Diagnóstico

- \`auth/service.ts\` concentra 640 linhas e 11 dependências diretas
- o *cache* de sessão é um \`Map\` global, então o teste vaza estado entre casos
- a emissão de token importa o cliente de banco só para ler a chave de assinatura
- não há **fronteira** entre erro de credencial e erro de infraestrutura

## A mudança proposta

\`\`\`typescript
// auth/credentials.ts — só valida, não conhece token nem cache.
export interface Credential {
  readonly user: string;
  readonly secret: string;
}

export async function verify(store: CredentialStore, input: Credential): Promise<Identity> {
  const found = await store.byUser(input.user);
  if (found === null) throw new InvalidCredential("usuário desconhecido");
  const ok = await constantTimeCompare(found.hash, hash(input.secret));
  if (!ok) throw new InvalidCredential("segredo não confere");
  return { id: found.id, user: found.user, roles: found.roles };
}
\`\`\`

O \`constantTimeCompare\` é o ponto que **não** pode virar \`===\`: comparação
curto-circuitada vaza o tamanho do prefixo correto por tempo de resposta.

`;

const OUTRO = `## Migração

1. Extrair \`credentials.ts\` sem mexer em quem chama — o serviço passa a delegar
2. Mover o *cache* para \`sessions.ts\` com ciclo de vida explícito
3. Trocar o \`Map\` global por instância injetada, e o teste para de vazar
4. Só então apagar o código morto de \`service.ts\`

\`\`\`bash
# a ordem importa: o passo 4 depende de o 1 já estar em produção
pnpm test --filter auth
pnpm build && pnpm lint
git commit -m ":recycle: 4821 Extraído credentials do serviço de autenticação"
\`\`\`

## Riscos

O risco real está no passo 3: o \`Map\` global hoje é o que mantém a sessão viva
entre requisições no processo de desenvolvimento. Injetar a instância *sem*
subir o backend de sessão derruba o login local, e o sintoma aparece como
"token inválido" — que é a mensagem errada para a causa.
`;

/** Uma seção a mais de prosa: é o que dá corpo ao texto até o tamanho realista. */
function section(index: number): string {
  return `### Detalhe ${index}: fronteira de erro

Quando \`verify()\` estoura com \`InvalidCredential\`, a borda HTTP responde **401**;
qualquer outra exceção é *infraestrutura* e vira **503** com \`Retry-After\`. Hoje
os dois casos caem no mesmo \`catch\` e viram 500, o que faz o cliente reagir
errado: ele repete uma senha errada ${index} vezes em vez de pedir outra.

- entrada inválida → \`InvalidCredential\` → 401, sem repetição
- banco fora do ar → \`StoreUnavailable\` → 503, com repetição
- chave de assinatura ausente → \`ConfigError\` → 500, e alerta de plantão

`;
}

/**
 * ~8 KB, que é a faixa de uma resposta longa de modelo (4–12 KB). O número de
 * seções é calculado, não chutado: mudar a prosa não deve encolher a carga em
 * silêncio e fazer o benchmark "melhorar" sozinho.
 */
export const CORPUS = ((): string => {
  let text = INTRO;
  let index = 1;
  while (text.length + OUTRO.length < 8 * 1024) {
    text += section(index);
    index += 1;
  }
  return text + OUTRO;
})();

/**
 * As fatias do streaming. 800 pedaços sobre 8 KB dá ~10 caracteres por delta,
 * que é a ordem de grandeza de um token.
 */
export function slice(text: string, count: number): string[] {
  const size = Math.ceil(text.length / count);
  const out: string[] = [];
  for (let at = 0; at < text.length; at += size) out.push(text.slice(at, at + size));
  return out;
}

export const CHUNKS = slice(CORPUS, 800);

/* ------------------------------- os cenários ------------------------------ */

/**
 * `time: 0` com `iterations` fixo faz o tinybench rodar um número EXATO de
 * amostras em vez de encher uma janela de tempo — com cenário de centenas de
 * milissegundos, a janela padrão renderia duas ou três amostras e a estatística
 * não valeria nada. O aquecimento existe para o JIT já ter compilado o parser
 * quando a primeira amostra contar.
 */
const SLOW = { time: 0, iterations: 12, warmupTime: 0, warmupIterations: 3 };
const FAST = { time: 0, iterations: 60, warmupTime: 0, warmupIterations: 20 };

describe("markdown no caminho quente", () => {
  bench(
    "resposta longa parseada uma vez",
    () => {
      renderMarkdown(CORPUS);
    },
    FAST
  );

  bench(
    "streaming de 800 pedaços",
    () => {
      let acc = "";
      for (const chunk of CHUNKS) {
        acc += chunk;
        renderMarkdown(acc);
      }
    },
    SLOW
  );

  /**
   * O MESMO trabalho do cenário acima, pelo caminho incremental. Os dois ficam
   * lado a lado de propósito: o de cima é o controle, e é ele que denuncia se
   * alguém trocar o stream de volta por `renderMarkdown` no caminho quente.
   */
  bench(
    "streaming de 800 pedaços (incremental)",
    () => {
      const stream = createMarkdownStream();
      for (const chunk of CHUNKS) stream.push(chunk);
    },
    SLOW
  );
});

/* ---------------------------- o fio inteiro ------------------------------- */

/** Dez respostas já prontas na tela — a conversa que o delta re-renderiza. */
const THREAD = Array.from({ length: 10 }, (_, index) => section(index + 1));

/** A resposta em curso: 4 KB entregues em 200 deltas. */
const TAIL = slice(CORPUS.slice(0, 4096), 200);

/**
 * O custo por token do FIO, que é o que a pessoa sente.
 *
 * O primeiro cenário é o app antes: sem memoização por linha, um delta
 * re-renderiza o fio e reparseia o markdown de todas as linhas, inclusive as que
 * não mudaram. O segundo é o app depois: as linhas paradas são parseadas uma vez
 * (na montagem) e o delta toca só a linha que está sendo escrita.
 */
describe("fio de conversa durante o streaming", () => {
  bench(
    "10 linhas paradas + 200 deltas — reparse do fio inteiro",
    () => {
      let acc = "";
      for (const chunk of TAIL) {
        acc += chunk;
        for (const text of THREAD) renderMarkdown(text);
        renderMarkdown(acc);
      }
    },
    SLOW
  );

  bench(
    "10 linhas paradas + 200 deltas — só a linha que mudou",
    () => {
      for (const text of THREAD) renderMarkdown(text);
      const stream = createMarkdownStream();
      for (const chunk of TAIL) stream.push(chunk);
    },
    SLOW
  );
});
