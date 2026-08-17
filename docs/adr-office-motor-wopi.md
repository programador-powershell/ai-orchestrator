# ADR — Motor de edição da aba Office

**Data:** 2026-08-12 · **Status:** proposto (aguarda TI/SI) · **Decisão:** WOPI como contrato de armazenamento, **Collabora Online** como motor.

## Contexto

A aba Office hoje edita de verdade apenas HTML, Markdown, CSV e TXT. DOCX, XLSX, PPTX e PDF abrem somente leitura. O requisito é duplo:

1. abrir e salvar os formatos Office de verdade;
2. **comandos do chat alterarem o arquivo ao vivo**, com o usuário acompanhando.

O Office Command Engine (`lib/office/commands.ts`) já resolve a parte de governança: a IA não edita arquivo, ela emite operações estruturadas que passam por validação por formato. O que falta é o motor que aplica essas operações num binário OOXML.

## O que a pesquisa apurou

**WOPI não é o editor.** O WOPI *client* é o editor (Microsoft 365 for the web, Office Online Server, Collabora Online, ONLYOFFICE Docs); o WOPI *host* é quem guarda o arquivo — nós. Implementamos o host: endpoints REST sob `/wopi` mais uma host page com `<iframe>`.

### Por que o caminho Microsoft está fechado — dois bloqueios independentes

1. **Cloud Storage Partner Program.** Apontar o iframe para o Office for the web público exige participar do CSPP, e a documentação é literal: o programa é para ISVs cujo negócio *é* armazenamento em nuvem, e **não é aberto a clientes do Microsoft 365 diretamente**. A AI-BOT é cliente M365, não ISV de storage. Ter todos os usuários licenciados não muda isso.
2. **Office Online Server tem retirement em 2027-01-01.** Em agosto de 2026 são ~5 meses de suporte. Não se constrói produto novo sobre infra que morre no ano seguinte.

### Por que Microsoft também não entregaria o "ao vivo"

A PostMessage API do M365 for the web aceita do host apenas `App_PopState`, `Blur_Focus`, `CanEmbed`, `Grab_Focus`, `Host_PerfTiming`, `Host_PostmessageReady` e `Host_IsFrameTrusted` — a doc afirma que todas as outras são ignoradas. **Nenhuma toca no conteúdo do documento.** Não existe API de automação.

Escrever no arquivo por fora (PutFile direto) também não funciona, e o problema não é só o lock: o editor mantém a cópia autoritativa em memória e sobrescreve nossa escrita no autosave seguinte. O protocolo **não tem sinal host→client de "recarregue"**. O resultado é lost update garantido.

### As opções que entregam

| Motor | Licença | Edição ao vivo | Observação |
| --- | --- | --- | --- |
| **Collabora Online / CODE** | MPL-2.0 | **Sim** — `Send_UNO_Command` despacha qualquer comando UNO do LibreOffice com argumentos tipados; `Action_Paste` cola no cursor | Motor LibreOffice: risco de fidelidade OOXML |
| ONLYOFFICE Docs | AGPL-3.0 | Sim, mas a Automation API é **exclusiva da edição Developer, paga** | Fidelidade OOXML nativa (melhor); Community tem teto de 20 conexões |
| M365 / Office Online Server | — | **Não** | Bloqueado por CSPP e por retirement |

## Decisão

**WOPI como contrato de armazenamento e ciclo de vida** (quem é dono do byte, lock, save) — implementado por nós em Rust. **Collabora Online como motor**, por ser a única opção que entrega o "ao vivo" sem licença paga e sem AGPL.

**A edição ao vivo NÃO passa por WOPI.** Ela passa pela API de automação do editor (postMessage/UNO). São dois canais separados e devem ser dois módulos separados no código. O `OfficeCommand` continua sendo o vocabulário validado; só o `apply()` deixa de mexer numa string e passa a despachar UNO no iframe.

Isso é o que o `lib/office/adapter.ts` já antecipou: trocar o motor não muda o resto do AI-BOT, só a implementação de um adapter.

## Consequências

**`OfficeAdapter.apply()` deixa de ser síncrono e deixa de devolver `content: string`** — postMessage é fire-and-forget e a confirmação volta por mensagem. Isso obriga a mexer em `session.ts` e no `useEffect` de aplicação do `OfficeView`.

**O undo seletivo do painel "Histórico da IA" não sobrevive como está.** Hoje o `changeLog` guarda `before`/`after` como string do documento inteiro e só reverte se `current === entry.after` — precisão comprada por sermos donos do conteúdo. Com o editor vivo não somos: o usuário digita entre duas operações e nenhum snapshot bate. Saída escolhida: checkpoint binário por **lote** (GetFile no nosso próprio host antes de cada lote da IA; reverter = restaurar + recarregar o iframe) e `.uno:Undo` para operação isolada. **A promessa atual de reverter uma operação específica no meio de outras não se sustenta e deve ser reduzida conscientemente.**

**`officeContextMessage()` para de derivar estrutura de string** — num DOCX isso seria lixo binário. Passa a vir de extração no Rust (descompactar o OOXML, ler `word/document.xml`, abas do `xl/workbook.xml`, títulos de slide) e a seleção corrente passa a ser alimentada por postMessage do editor.

**Dependência nova:** o WOPI host exige um servidor HTTP em Rust (axum/hyper) — hoje o Cargo.toml só tem `reqwest`, que é client. Isso é mudança de cadeia de suprimentos e **passa por homologação de TI/SI antes de virar código**. Subir container do Collabora idem.

## Riscos

**Fidelidade OOXML é o risco número um e não tem mitigação técnica, só teste.** O Collabora edita via motor LibreOffice, e todo arquivo que passar pela aba sofre round-trip (abre → IA edita → PutFile). Um contrato ou proposta em .docx com estilos, campos, numeração e cabeçalho pode voltar diferente do que o Word produziria. **Antes de liberar para usuário:** bateria com 20–30 documentos reais da empresa, comparados abrindo no Word/Excel de verdade.

**Concorrência IA × usuário.** O usuário digita no iframe enquanto a IA despacha operações. Não há transação: se o cursor mudou entre a leitura da estrutura e o dispatch, a IA edita o lugar errado. O painel de aprovação (>3 comandos) não cobre o caso de 1 comando aplicado direto.

**Dados em trânsito.** O Collabora recebe o conteúdo integral dos documentos. Só faz sentido self-hosted em infra da AI-BOT, com imagem homologada — fora disso é vazamento de documento corporativo.

**Granularidade do UNO.** UNO é API de comandos de UI, não de modelo de documento. "Aplicar fórmula na coluna inteira" ou "inserir tabela 3x4 formatada" podem exigir sequências frágeis de seleção+comando. **Por isso o PoC vem antes do WOPI host.**

## Ordem de execução

1. **PoC de risco (timebox 1–2 dias)** — CODE em container, WOPI host stub de ~150 linhas, provar quatro operações via `Send_UNO_Command`: substituir texto (`.uno:ExecuteSearch`), inserir parágrafo (`Action_Paste`), escrever célula (`.uno:GoToCell` + `.uno:EnterString`), comentário (`.uno:InsertAnnotation`). **Se substituir texto ou escrever célula falhar, a arquitetura inteira muda.**
2. Homologação TI/SI: crate de servidor HTTP + imagem do Collabora.
3. WOPI host em Rust (file_id opaco e estável, lock com expiração de 30 min, `access_token_ttl` como timestamp absoluto, discovery cacheado).
4. `CollaboraAdapter` mapeando `OfficeCommand` → UNO.
5. Retrabalho de `changeLog`, `session` e `OfficeView`.

## Questões em aberto (decidir antes do passo 3)

- **Onde o Collabora roda?** Container na máquina de cada usuário (simples de desenvolver, ruim de auditar, e força o WOPI host a bindar fora de `127.0.0.1`) ou servidor central da empresa (correto, mas move o host para fora do Tauri, para `services/`)? **Isso muda onde o código nasce.**
- CODE (grátis, sem SLA, feito para desenvolvedor) ou assinatura Collabora Online? Para uso corporativo amplo, CODE em produção é escolha que a TI precisa assumir explicitamente.
- **O "ao vivo" precisa ser dentro do editor, ou "a IA altera e o documento recarrega em 1–2 segundos" já atende?** A segunda opção é dramaticamente mais barata — edita o OOXML no Rust, reabre o iframe — e funcionaria com qualquer motor. Vale confirmar antes de pagar o preço da primeira.
- Coautoria (dois usuários no mesmo documento) é requisito? Se for, muda o desenho do lock e do change log.
