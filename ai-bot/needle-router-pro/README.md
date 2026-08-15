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

