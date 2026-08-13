# ADR — Computer use do agente (área de trabalho isolada)

**Status:** implementado com escopo restrito · **pendente de parecer de TI/SI**
**Data:** 2026-08-13
**Regra aplicável:** instrução de segurança nº 4 (ferramentas externas e riscos) e nº 5 (automações podem executar ações inesperadas; a revisão é do usuário)

## Contexto

A aba Agent passou a **acionar agentes**: um agente raiz decide, em execução,
dividir o trabalho e acionar subordinados. Para várias tarefas reais isso não
basta — o agente precisa *fazer*, não só descrever: escrever um script, rodar,
ler a saída, corrigir e rodar de novo.

A referência estudada (agent-zero, MIT — **nenhum código copiado**, só
conceitos) dá ao agente um Linux completo, com cada subordinado num **contêiner
Docker próprio**. Não temos essa base: o app é um cliente Tauri na estação do
usuário, e Docker não está homologado.

## Decisão

Implementar computer use **confinado**, com quatro travas, e **não** implementar
acesso livre à máquina.

1. **Sessão isolada.** Um diretório criado no início da execução, reaproveitado
   entre chamadas e **removido no fim** (inclusive em erro ou cancelamento).
   Continuidade é o que torna o agente útil; permanência não é necessária.
2. **O agente nunca recebe um caminho.** Ele manda um *id de sessão*; quem
   resolve o caminho real é o Rust. `..`, raiz e caminho absoluto são recusados
   no texto, e o diretório pai é canonicalizado e comparado com a base — o que
   também pega link simbólico apontando para fora.
3. **Job Object obrigatório.** Todo comando nasce suspenso, é preso ao job e só
   então liberado. Teto de processos e memória, restrições de UI, e a **árvore
   inteira é encerrada** no fim — inclusive netos órfãos.
4. **Aprovação humana por execução.** `computer_exec` pede confirmação a cada
   chamada, mostrando o comando. Escrever e ler dentro da pasta efêmera não
   pede; executar, sim.

E, no produto: **o recurso nasce desligado**. Ligá-lo é um ato explícito, com o
texto do limite ao lado do interruptor.

### O buraco que isto fechou

`sandbox_execute` aceitava um `cwd` arbitrário do chamador. Para uma pessoa
clicando no painel do Security isso é uma escolha legítima. Para um **agente**
seria a saída da caixa: bastaria pedir `cwd: "C:\Users\<usuário>"`. Por isso a
sessão tem precedência e o caminho do agente nunca é texto livre.

## O que isto NÃO é — e precisa constar da homologação

Isto confina **caminho** e garante **encerramento de processo**. **Não reduz
privilégio.**

- O comando roda com o **token do usuário**. Um comando que saiba um caminho
  absoluto ainda lê arquivos fora da sessão pelo shell.
- **A rede está parcialmente contida.** O admin define uma BLOCKLIST de domínios por grupo (bloqueia pesquisa, webhook e MCP), aplicada no Rust sobre a política assinada. Não há allowlist nem proxy: o que não estiver na lista sai.
- Não é AppContainer, não é contêiner, não é VM.
- O `PATH` é mínimo e o ambiente é limpo (`env_clear`), o que reduz acidente —
  não um adversário.

A barreira real contra um comando ruim é a **aprovação humana**, e ela vale o
que valer a atenção de quem clica. É exatamente o risco que a instrução nº 5
manda declarar.

## Alternativas descartadas

| Alternativa | Por que não |
| --- | --- |
| Docker por subordinado (como o agent-zero) | Dependência não homologada; exige Docker Desktop em cada estação (instrução nº 2) |
| AppContainer / token restrito no Windows | Reduziria privilégio de verdade, mas quebra ferramentas comuns (Python, git) e exige perfil de capacidades por caso — trabalho de núcleo, não incremento |
| Executar na VPS em vez da estação | É o caminho certo a médio prazo, e depende do deploy da VPS, que está fora do escopo atual |
| Não implementar | Deixaria o agente limitado a descrever o que faria |

## O que TI/SI precisa avaliar

1. **Aceita** um agente executando comando na estação com o privilégio do
   usuário, tendo como barreira a aprovação por chamada?
2. ✅ **Resolvido: para quais grupos.** `computerUseAllowed` é campo da política
   do grupo no gateway, resolvido com "todos precisam permitir" e **fechado por
   omissão** — silêncio do admin não é permissão.
3. **Egressos.** Existe **blocklist por grupo** (união entre grupos), aplicada
   no Rust sobre a política assinada, valendo para pesquisa, webhook e MCP.
   Não há allowlist nem proxy: o que não estiver na lista sai. A pergunta que
   resta: a blocklist basta, ou é preciso inverter o modelo (só o que for
   liberado sai)?
4. ✅ **Resolvido: registro.** Cada `computer_exec` — aprovado **e recusado** —
   entra na tabela `agent_actions` com o comando já redigido de segredos.
   Tabela própria, não `usage_events`: misturar corromperia o relatório de
   custo, inflando a contagem de chamadas.

### Limite conhecido da blocklist

A checagem do MCP acontece no **renderer** (o cliente MCP usa `fetch` do
webview, sem passar pelo Rust) e o `tauri.conf.json` está com `csp: null`.
Quem abrir as ferramentas de desenvolvedor contorna. Rotear o MCP pelo Rust é
a correção de verdade e está registrada como pendência — não como resolvida.

## Consequências

- Positivo: o agente executa e verifica o próprio trabalho; o fluxo spec-driven
  passa a ter executor real para as tarefas.
- Negativo: superfície de execução nova no binário, com risco que **não** é
  eliminado pelo confinamento — só reduzido e tornado visível.
- Reversível: `computerUse` é um parâmetro do runtime; desligá-lo remove as
  quatro ferramentas do prompt e a sessão nunca é aberta. Compilar fora, como é
  feito na edição gerenciada com os caminhos de provedor, é um passo adicional
  disponível se TI/SI preferir.

## Referências de implementação

- `apps/desktop/src-tauri/src/workspace.rs` — sessão e confinamento de caminho
- `apps/desktop/src-tauri/src/jail.rs` — Job Object
- `apps/desktop/src-tauri/src/sandbox.rs` — execução
- `apps/desktop/src/lib/computerUse.ts` — ferramentas e instrução ao modelo
- `apps/desktop/src/lib/agentRuntime.ts` — ciclo de vida da sessão
