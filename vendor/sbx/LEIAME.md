# Docker Sandboxes (`sbx`) — onde os binários entram

Esta pasta é o **ponto de entrega** do `sbx`. O app procura `sbx.exe` aqui
antes de procurar no `PATH` (ver `apps/desktop/src-tauri/src/sbx.rs`).

## O que o `sbx` faz aqui, e o que ele NÃO faz

**Só carga Docker passa por ele. Todo o resto continua no Job Object**
(`jail.rs`). Os dois resolvem problemas diferentes:

| | Job Object (`jail.rs`) | `sbx` |
| --- | --- | --- |
| Contém a árvore de processos | sim | sim |
| Mata neto órfão | sim | sim |
| Daemon Docker próprio | **não** | sim |
| Filesystem próprio | não | sim |
| Rede própria | não | sim |

Construir imagem exige um daemon. Usando o daemon do host, um `Dockerfile` com
`RUN curl … | sh` roda com o alcance do daemon — a rede do host, o socket do
host, as imagens do host —, e o Job Object não tem como impedir isso, porque o
processo que ele contém é o cliente, não o daemon. É essa lacuna, e só ela,
que o `sbx` fecha.

Fora do Docker, exigir microVM seria caro, desnecessário, e quebraria toda
máquina que ainda não tem o `sbx` instalado.

## Estado atual: os binários NÃO estão aqui

A pasta está vazia de propósito, e a razão é a licença.

O `sbx` é distribuído sob:

```
Copyright © 2026 Docker Inc. All rights reserved.
```

**"All rights reserved" não concede direito de redistribuição.** Commitar os
binários neste repositório — que é publicado no GitLab interno e no GitHub —
seria redistribuir software proprietário sem licença para tal. Isso é decisão
jurídica da empresa, não técnica, e precisa de posição da TI/SI antes de
acontecer.

O ponto prático: **o app funciona sem vendorizar nada.** A busca cai no `PATH`,
e a via de instalação que a própria Docker indica no Windows é

```powershell
winget install -h Docker.sbx
```

Instalado assim, `sbx_status` passa a responder `origem: "path"` e o
`docker build` do deploy roda dentro da microVM, sem um byte proprietário
neste repositório.

## Se a TI decidir vendorizar mesmo assim

1. Obter da Docker autorização de redistribuição por escrito (ou confirmar que
   o contrato corporativo já cobre).
2. Extrair o `DockerSandboxes.msi` (release fixado — anotar a versão abaixo) e
   copiar `sbx.exe` e as dependências para esta pasta.
3. Acrescentar a pasta em `bundle.resources` no `tauri.conf.json`, para o
   instalador levá-la junto.
4. Registrar aqui a versão, a data e quem autorizou.

| Versão fixada | Data | Autorização |
| ------------- | ---- | ----------- |
| —             | —    | pendente    |

## Origem

- Repositório: `docker/sbx-releases`
- Documentação: `docs.docker.com/ai/sandboxes/`
- Vulnerabilidades: `security@docker.com` (não abrir issue pública)
