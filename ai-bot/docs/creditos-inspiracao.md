# Créditos e inspiração

O AI-BOT é escrito aqui. As referências abaixo foram estudadas **fora do
repositório**, em regime clean-room: levantamento funcional (telas, fluxos e
semântica de API descritos em palavras próprias), nunca a partir do código-fonte.
Nenhum arquivo, trecho ou asset de terceiro foi copiado para cá.

A única exceção prevista é o **Needle**, que é biblioteca **nativa vinculada** (não
código copiado) e está atrás de uma tag de build — ver a seção própria.

| Referência | Licença | O que inspirou | Situação |
| ---------- | ------- | -------------- | -------- |
| [Orca](https://github.com/stablyai/orca) (Stably AI) | MIT | **Modelo de orquestração**: despacho de tarefa para trabalhador, espera por `worker_done` **ou** escalação, DAG de tarefas com dependências, portão de decisão entre ondas, e — o que mais importa — **um git worktree por agente que escreve no repositório**. Virou o vocabulário do `protocol` (`task.dispatch`, `worker.done`, `escalate`, `ask`, `reply`, `gate`) e o `internal/worktree`. | Levantamento funcional; implementação própria em Go. Zero código de lá. **Pendente de análise de TI/SI** como referência externa nova. |
| [Bible Strong Avatar Lab](https://avatars.bible-strong.app/) ([smontlouis](https://github.com/smontlouis)) | não declarada no site | **Estúdio de avatar 2D procedural**: partes compostas por parâmetro, expressão e animação, com exportação em SVG. Virou o `apps/desktop/src/avatar` — o retrato de cada bot especialista é gerado por parâmetro (forma, olhos, boca, acessório, movimento, matiz, semente), não é arquivo de imagem. | Levantamento funcional a partir da página pública; geometria, PRNG e animações escritos aqui. Zero código e zero asset de lá. **Pendente de análise de TI/SI**. |
| [Needle 2](https://github.com/cactus-compute/needle) (Cactus Compute) | ver repositório | **Modelo local minúsculo** (~45 M de parâmetros, ~14 MB, ~28 MB de RAM) que faz *tool calling* no formato function-calling. É o **segundo degrau** do roteamento: decide o modo do primeiro input na máquina, sem rede e sem custo por token. | **Biblioteca nativa vinculada por cgo**, não código copiado. Fica atrás da tag de build `needle`; sem ela o binário não referencia nada de lá. **Bloqueado até análise de TI/SI** — ver abaixo. |
| [openship](https://github.com/openship) | Apache-2.0 | Registro de stacks e gerador de Dockerfile, no produto anterior. | **Não portado** para o AI-BOT nesta versão. |

## Needle: por que a tag de build existe

O `internal/needle` compila em duas formas:

- **sem** `-tags needle` (padrão): `session_stub.go` assume, `Ready()` devolve
  `false`, a cascata pula o degrau local e o roteamento fica *fast router →
  modelo grande*. O binário **não** referencia símbolo nenhum da biblioteca, e
  `CGO_ENABLED=0` continua produzindo um executável estático.
- **com** `-tags needle`: `session_cgo.go` assume e o binário passa a exigir
  `needle.dll` / `libneedle.so` / `libneedle.dylib`.

A tag não é conveniência de build — é o interruptor da política. O Needle seria
uma dependência de terceiro **dentro do processo que lê o prompt do usuário e
decide o roteamento**, e o item 4 da política de segurança da casa exige análise
de TI/SI antes disso. Enquanto a análise não sai, o produto funciona sem ele.

`internal/needle/needle_shim.c` é o **único** arquivo que conhece a API C da
biblioteca. As chamadas de lá estão marcadas com `>>> UPSTREAM <<<` e precisam
ser conferidas contra o cabeçalho da release baixada: elas foram escritas contra
a forma documentada da biblioteca, e o nome exato dos símbolos é detalhe de
versão. Ligar a tag sem conferir dá **erro de link** — não comportamento errado
em silêncio, que é a falha certa para se ter num lugar como este.

## Regras vigentes

1. **Nada de código AGPL** entra neste repositório: contaminaria o produto
   inteiro com a obrigação de abrir o código.
2. Referência externa é estudada **fora** do repositório e registrada aqui como
   levantamento funcional.
3. Toda ferramenta, biblioteca ou referência externa nova é submetida à análise
   de **TI/SI** antes de virar padrão (política de segurança da empresa, item 4).
   A aprovação é **por dependência** — aprovar uma não aprova a seguinte.
4. Dependência de terceiro **no gateway** exige justificativa escrita. Hoje são
   **zero**: `services/gateway/go.mod` não tem um único `require`. WebSocket,
   armazenamento durável e JSON-RPC foram escritos à mão exatamente por isso, e o
   `go.mod` diz onde cada um mora.
