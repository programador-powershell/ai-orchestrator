# Atualização do AI-BOT

## O problema

Recompilar o aplicativo inteiro — Rust, instalador, assinatura, distribuição —
para trocar uma frase de prompt é caro e lento. E é o que acontece quando tudo
mora dentro do binário: o conserto de uma palavra e a troca do motor de execução
custam a mesma coisa.

## A observação que resolve

**Quase tudo o que é "funcionalidade nova" no AI-BOT é DADO, não código.**

Um especialista é um `Definition`: prompt de sistema, radicais do roteador,
superfície, barra lateral, placeholder, atalhos do composer, ferramentas
permitidas e os parâmetros do avatar. Nada disso é lógica — é conteúdo. Foi por
isso que o registro nasceu como dado (ver o cabeçalho de
`internal/specialist/specialist.go`), e é isso que agora paga.

Então a atualização é dividida por **o que muda**, não por "o app":

```
┌── A · DADOS ──────────────────────── segundos, sem build ───┐
│  catálogo de especialistas (prompt, radicais, ferramentas,  │
│  avatar), catálogo de modelos, política                      │
│  JSON assinado · buscado pelo gateway · aplica a quente      │
└──────────────────────────────────────────────────────────────┘
┌── B · INTERFACE ────────────── minutos, sem recompilar Rust ─┐
│  o bundle web (React) — telas, superfícies, correções de UI  │
│  tar assinado · trocado na próxima abertura · com rollback   │
└──────────────────────────────────────────────────────────────┘
┌── C · CÉREBRO ──────────────── minutos, sem tocar na janela ─┐
│  aibotd.exe — roteamento, ferramentas, protocolo             │
│  binário assinado · é sidecar, então basta reiniciar ele     │
└──────────────────────────────────────────────────────────────┘
┌── D · CASCA NATIVA ───────────────────── raro, instalador ───┐
│  Tauri/Rust — janela, PTY, Job Object, cofre do SO           │
│  NSIS assinado · updater do Tauri · exige reinstalar         │
└──────────────────────────────────────────────────────────────┘
```

Na prática: **um especialista novo, um prompt melhor, um radical de roteamento a
mais, um modelo no catálogo — trilha A.** Uma superfície redesenhada — trilha B.
Uma ferramenta nova ou um conserto de protocolo — trilha C. Só mexer em PTY,
Job Object, cofre ou janela cai na D.

## O manifesto, e por que ele é o centro

Toda trilha (menos a A, que é menor) é descrita por um manifesto único:

```jsonc
{
  "schemaVersion": 1,
  "product": "AI-BOT",
  "channel": "stable",
  "version": "0.2.0",
  "publishedAt": "2026-08-14T12:00:00Z",
  "minimumShellVersion": "0.1.0",   // abaixo disso, exige a trilha D
  "artifacts": [
    { "track": "data",    "id": "specialists", "url": "https://…/specialists.json",
      "size": 24576,    "sha256": "…" },
    { "track": "ui",      "id": "bundle",      "url": "https://…/ui-0.2.0.tar",
      "size": 1048576,  "sha256": "…" },
    { "track": "gateway", "id": "aibotd",      "url": "https://…/aibotd-0.2.0.exe",
      "size": 12582912, "sha256": "…" }
  ],
  "signature": "…"   // Ed25519 sobre o corpo canônico, base64url sem padding
}
```

`minimumShellVersion` existe porque as trilhas não são independentes de verdade:
uma interface que usa um comando Tauri que a casca instalada não tem abre em
branco. O manifesto declara o piso, e o app recusa a atualização em vez de se
quebrar.

## A parte que não é negociável

Buscar código de um servidor e executá-lo é, literalmente, o item "baixar ou
executar arquivos de fonte não confiável". O que torna isso aceitável é o
conjunto abaixo — e ele vale por inteiro, não em pedaços:

1. **Ed25519 sobre o manifesto**, com a chave pública **embutida no binário em
   tempo de compilação** (`AIBOT_UPDATE_PUBLIC_KEY`, via `option_env!`). Chave que
   viaja junto com o que ela assina não assina nada.
2. **SHA-256 por artefato**, conferido **em streaming**, gravando em `.part` e só
   então renomeando. Arquivo meio baixado nunca vira arquivo válido.
3. **Verificação no RUST**, antes de qualquer coisa rodar — não em JavaScript. O
   verificador não pode ser a coisa verificada.
4. **HTTPS e host fixado**, pelas mesmas guardas de `internal/netguard`: resolve
   uma vez, confere cada IP, disca no aprovado. Sem isso, "atualização" é o
   caminho mais curto para um SSRF virar execução.
5. **Rollback**: a versão anterior fica no disco até a nova abrir e reportar
   saúde. Atualização que não sabe voltar é atualização que transforma um bug em
   um app que não abre.
6. **Nada de auto-aplicar sem dizer.** As trilhas A e C aplicam sozinhas (dado e
   sidecar); a B avisa e aplica na próxima abertura; a D **pede** — é instalador.

E o que **nunca** é atualizado por este caminho: a casca Rust (é ela quem
verifica), a CSP e a semântica do portão de permissão. Quem pode trocar o portão
por rede não tem portão.

### O risco que precisa estar escrito

O bundle da interface roda com acesso a `invoke()` — ou seja, alcança todos os
comandos Tauri registrados. **Um bundle adulterado é uma máquina
comprometida**, no mesmo grau que um instalador adulterado. Por isso a trilha B
tem exatamente o mesmo rigor de assinatura da trilha D, e não um "é só o
front-end, é HTML".

## Como fica no dia a dia

| Você mudou | Trilha | O que o usuário faz |
| --- | --- | --- |
| prompt de um especialista | A | nada — chega em segundos |
| radical de roteamento, modelo no catálogo | A | nada |
| um especialista novo inteiro | A | nada (o avatar é procedural) |
| uma superfície, um estilo, um texto de tela | B | reabre o app |
| ferramenta nova, conserto de protocolo | C | nada — o sidecar reinicia |
| PTY, Job Object, cofre, janela, CSP | D | instala a versão nova |

## Canal e reversão

`channel` no manifesto (`stable` / `beta`). A estação guarda o canal escolhido e
só olha o manifesto dele. Reverter é publicar um manifesto com a versão anterior:
como cada artefato é imutável e endereçado por hash, voltar é baixar de novo o que
já foi verificado uma vez — não é um caminho especial que ninguém testa.
