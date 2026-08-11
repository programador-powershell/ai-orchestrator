# third_party — repositórios embutidos (vendorizados)

Snapshots clonados dos upstreams (sem `.git`), embutidos no produto. O app
**não instala nada**: o que roda, roda da cópia local; o que exige runtime
externo fica rotulado honestamente na UI.

| Repositório | Licença | Papel no AI Orchestrator |
| ----------- | ------- | ------------------------ |
| `soup/` ([MakazhanAlpamys/Soup](https://github.com/MakazhanAlpamys/Soup)) | **Apache-2.0** (LICENSE + NOTICE preservados) | **Embutido e executável.** `soup/src/soup_cli` + `templates` entram como recurso do app desktop (`third_party/soup/…` ao lado do exe). A aba Fine-Tuning roda a cópia via `run_soup.py` (launcher nosso) quando existe Python com as dependências ML — sem `pip install`. Sem runtime, a aba segue 100% funcional pelo treino interno na nuvem. |
| `opencode/` ([opencode-ai/opencode](https://github.com/opencode-ai/opencode)) | **MIT** | **Referência embutida.** O CLI da aba Code é uma reimplementação nativa (cópia funcional do opencode + detecção de linguagem do ultra-terminal) — não executamos o binário Go. O snapshot fica como fonte de paridade/estudo. |
| `drawdb/` ([drawdb-io/drawdb](https://github.com/drawdb-io/drawdb)) | **AGPL-3.0 ⚠️** | **Somente referência — NUNCA compilar no app.** AGPL contaminaria o produto inteiro (obrigação de abrir o código). A aba Data é implementação própria inspirada no visual. Qualquer uso além de referência deve ser submetido à TI/SI. |

## Regras

1. `soup/run_soup.py` é o único arquivo nosso dentro dos snapshots (launcher).
2. Atualização = novo clone raso por cima (remova `.git`), preservando este arquivo.
3. **Nada de `drawdb/` pode ser importado/copiado para `apps/`** (AGPL-3.0).
4. Recursos empacotados no desktop: apenas `soup/src`, `soup/templates`,
   `soup/run_soup.py`, `soup/LICENSE`, `soup/NOTICE` (ver `tauri.conf.json`).
