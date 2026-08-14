# Créditos e inspiração (clean-room)

O Multiplike-AI **não embute código de terceiros**: todas as funcionalidades
abaixo são implementações próprias em TypeScript/Rust, escritas em regime
clean-room a partir de levantamentos funcionais (telas, fluxos e semântica de
API descritos em palavras próprias) — nunca a partir do código-fonte. Os
repositórios de referência NÃO fazem parte deste repositório desde a V.3
(histórico anterior no git).

| Referência | Licença | O que inspirou | Situação |
| ---------- | ------- | -------------- | -------- |
| [Unsloth Studio](https://github.com/unslothai/unsloth) | AGPL-3.0 ⚠️ | Fluxo/UX do harness de fine-tuning (Train em Configure/Current Run/History, shell com sidebar) e semântica da API de jobs | Apenas referência funcional, estudada FORA do repo; zero código/markup/assets copiados; identidade visual própria (sem verde da marca, mascote ou fonte Hellix) |
| [drawdb](https://github.com/drawdb-io/drawdb) | AGPL-3.0 ⚠️ | Editor ERD da aba Data | Implementação própria; clone removido na V.3 |
| [opencode](https://github.com/opencode-ai/opencode) | MIT | CLI/fluxo agêntico da aba Code | Reimplementação nativa; clone removido na V.3 |
| [Soup](https://github.com/MakazhanAlpamys/Soup) | Apache-2.0 | Fluxo de fine-tuning (substituído pelo treino 100% em nuvem) | Execução local removida na V.3; clone removido |
| [Grok Build](https://github.com/xai-org/grok-build) | Apache-2.0 | **Sistema de cores semântico** do terminal da aba Code (V.10): a ideia de dar token próprio a cada PAPEL de linha (comando, caminho, erro, sucesso, ferramenta, agente) em vez de uma cor única, a ramp cinza neutra em duas polaridades e a borda de prompt que reage ao foco | Levantamento funcional (temas `groknight`/`grokday` e guia de theming lidos FORA do repo); valores da nossa ramp e dos acentos redigitados em `tokens.css` como `--term-*`; nenhum código, arquivo de tema ou asset copiado — o alvo lá é TUI em Rust/ratatui, aqui é CSS |

## Regras vigentes

1. **Nada de código AGPL** pode ser importado/copiado para este repositório —
   contaminaria o produto inteiro (obrigação de abrir o código).
2. Referências externas são estudadas fora do repo e registradas como
   levantamento funcional em `docs/superpowers/specs/`.
3. Uso de qualquer ferramenta/referência externa nova deve ser submetido à
   análise de TI/SI (política de segurança Multiplike, item 4).
