# Needle Router Pro

Artefato de pesquisa reproduzível para especializar o Needle **somente** na
escolha do proprietário da primeira mensagem de uma conversa. Ele não executa
ferramentas nem responde ao usuário.

O upstream é fixado em `v2.0.5` pelo `config/upstream.lock.json`. O binário não é
versionado: `scripts/fetch_needle.sh` instala o pacote e baixa o engine no cache
do usuário, preservando a separação entre pesquisa e runtime do gateway.

## Reprodução

```bash
./scripts/fetch_needle.sh .venv
.venv/bin/python evaluation/simulate.py --runs 36
.venv/bin/python -m unittest discover -s tests -v
```

`simulate.py` executa no mínimo 30 buscas cegas de configuração sobre `train`,
seleciona pelo score composto e só então mede `test` e `hard_test`. O relatório
inclui o baseline Needle real quando `cactus-needle` e o engine estão
disponíveis; sem eles o campo fica explicitamente `not_run`, nunca estimado.

O candidato produzido é um **perfil de especialização** do engine Needle (tools
constrained + sinais determinísticos + registry externo + calibrador/gate), não
uma mini-LLM generalista. Fine-tuning de pesos fica deliberadamente fora do
runtime normal; além disso, Needle 2.0.5 desabilita a confidence calibrada em
pesos LoRA, portanto um `.cact` treinado não deve ser promovido sem calibrador
externo e holdout.

## Aprendizado e novos especialistas

`integration/router_runtime.py` observa o Capability Registry e o recarrega
atomicamente quando ele muda. Cada capability disponível vira uma tool da
gramática constrained do Needle; capability desconhecida, indisponível ou sem
requirements nunca pode ser acionada. Portanto adicionar um especialista exige
registro e exemplos, mas não mudança de arquitetura nem rebuild dos pesos.

Correções sanitizadas e aprovadas entram no overlay por `learn_reviewed`. Tráfego
bruto ou não revisado é recusado. Esse aprendizado imediato atualiza exemplos e
tool descriptions; um retreino periódico dos pesos continua sendo uma etapa
offline, versionada e só é promovido depois dos benchmarks e da calibração.

## Plano inicial multi-specialist

Depois da rota inicial, `InitialOrchestrator` cria o plano uma única vez a partir
de templates externos. Uma aplicação completa continua com Owner `code`, mas o
plano chama Design, Data e Security nas atividades adequadas. Dependências
controlam o scheduler: Architecture; Design + Data; Code; Security + Tests;
Deployment. Concluir ou hibernar um auxiliar nunca troca o Owner da conversa.

## Inferência embarcada real

O caminho de produção é `NeedleEmbeddedRouter.classify`: ele carrega o engine
Needle residente, transforma o registry atualizado em tools constrained e envia
o texto original mais System Signals ao modelo. A decisão vem das function calls
produzidas pelo modelo, não de `semantic_route` nem do template. O primeiro call
define o Owner; calls adicionais sinalizam execução multi-specialist. Confidence
baixa, output vazio ou inválido não ativa bot algum: exige fallback forte.

`semantic_route` permanece somente como sinal determinístico de fusion e para
diagnóstico. O template é consumido depois da interpretação para materializar o
DAG validado; ele não decide qual specialty atende o prompt.
