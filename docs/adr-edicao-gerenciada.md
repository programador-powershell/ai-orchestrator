# ADR — Edição gerenciada: o admin controla as configurações e o servidor

**Data:** 2026-08-12 · **Status:** proposto (aguarda TI/SI) · **Decide:** como estruturar o client/server para que a política nasça no servidor e o usuário não consiga contorná-la.

## O princípio único

**O cliente nunca é a autoridade.** Hoje ele é: as configurações inteiras vivem no
`localStorage` (`orchestrator.v2`), o usuário digita o `baseUrl` do gateway que quiser
(Settings → Conexão), e o motor fala **direto** com o provedor (`provider_chat_stream`
com a chave do keyring) ou com o runtime local — sem passar pelo servidor. Qualquer
"bloqueio" feito só na interface é cosmético.

A estrutura correta tem uma regra só, aplicada em três camadas:

> Toda decisão de política nasce no servidor, viaja **assinada**, e é aplicada onde o
> usuário não alcança — na **rede** (gateway) e no **binário** (Rust). A UI apenas
> reflete; nunca decide.

## Por que não dá para "só esconder a aba" — os 6 bypasses confirmados

Verificados no código (duas rodadas de crítica adversarial, file:line):

1. **O gateway nunca vê `office` nem `tune`.** `engine.ts` (função `providerChat`,
   ~linha 301) reescreve modos fora do contrato para `chat` antes de chamar
   `/chat/completions`. O enum `Mode` do servidor (`services/gateway/src/models.rs`)
   não tem esses valores. Bloquear `office` no servidor não bloqueia nada.
2. **Nenhum endpoint checa módulo.** `chat()`, `generic()` e `design_replication()`
   (`routes.rs`) só fazem `require_role(..., 1)` — papel no workspace. Um `curl` com
   `{"mode":"agent"}` é atendido para qualquer membro.
3. **`visibleModes` é preferência, não política.** O usuário religa qualquer aba num
   clique (`VisibleTabsCard`), e as Configurações iteram `UI_MODES`, não o subconjunto.
4. **O redirect de aba bloqueada é `useEffect`** — a view proibida monta e roda seus
   efeitos antes do redirecionamento. Gate por efeito não é gate.
5. **Quatro portas de saída direta no Rust:** `provider_chat`, `provider_chat_stream`,
   `provider_chat_cancel`, `provider_fetch` (proxy HTTP genérico autenticado). E o
   fine-tuning (`lib/finetune.ts`) fala com `api.openai.com` direto — os 8 endpoints
   de finetune do gateway são código morto no cliente.
6. **`"csp": null`** no `tauri.conf.json`: mesmo compilando comandos fora, o webview
   faz `fetch` direto ao provedor no caminho de navegador. (Há sessão separada em
   andamento para definir a CSP.)

## Estrutura proposta

### 1. O servidor é a fonte da verdade

O gateway ganha o modelo de política (migration `0004`):

| Tabela | Papel |
| --- | --- |
| `ad_groups` | grupos do AD/Entra conhecidos do workspace (ObjectId + nome) |
| `group_modules` | grupo → módulos liberados (`mode` com CHECK incluindo `office`/`tune`) |
| `group_policies` | JSON por grupo: engines por módulo, `agentTools`, `approvalPolicy` (`ask`/`edits`/`all` — o tipo real), memória, BYOK |
| `prompt_masters` | prompt master do workspace + override por grupo, versionado |
| `user_group_memberships` | materializada a cada login, para o console admin |

**Regras de resolução** (novo `policy.rs`):
- `allowedModes` = **UNIÃO** dos módulos dos grupos do usuário (quem está em TI+Comercial vê os dois conjuntos);
- prompt master = workspace + override do grupo mais específico;
- campos booleanos de segurança (`byok.allowed`, `agentTools`): **o mais restritivo vence**.

Pré-requisito: adicionar `Office` e `Tune` ao enum `Mode` e nova migration para o
CHECK de `route_configs` (a migration antiga é imutável — checksum do `sqlx::migrate!`).

### 2. Contrato de bootstrap — o que o cliente busca ao logar

`GET /v1/bootstrap` (contrato em `packages/contracts`):

```
BootstrapResponse {
  schemaVersion, issuedAt, expiresAt, etag,
  signature,            // Ed25519 — OBRIGATÓRIA, não opcional
  profile  { userId, email, groups[], workspaceId, role },
  policy   {
    allowedModes[], modules[{mode, engine, agentTools, approvalPolicy}],
    promptMaster { text, version, allowLocalAppend, localMaxChars },
    modelCatalog[], fusionPresets[], mcpServers[], providerBaseOverrides{},
    byok{allowed}, localRuntime{allowed}, effort{default,max},
    memory{enabled, scope, retentionDays}, offlineGraceHours
  }
}
```

- O **workspace vem do grupo**, não é digitado. O campo de workspace some do cliente.
- Suporta `If-None-Match`/304 para revalidação barata.
- **Assinatura obrigatória, verificada no Rust** (não no JS), com a chave pública
  embarcada no binário — mesmo padrão do `pubkey` do updater. Assinatura opcional é
  assinatura ausente: sem isso, qualquer um sobe um gateway local que responde
  `allowedModes: todos` e o app obedece.
- Cache do documento assinado no keyring, com validade `offlineGraceHours`. Offline
  dentro da graça: funciona com a última política. Graça vencida: o app trava no login.

### 3. Enforcement em três camadas (da mais forte para a mais fraca)

**Camada 1 — Rede (gateway).** Todo endpoint de execução (`chat`, `generic`,
`design`, `finetune`) resolve a política do usuário e responde **404** — não 403 —
para módulo não liberado. 404 de propósito: o requisito é que o usuário *nem saiba
que o módulo existe*. O `engine` da rota também é resolvido **no servidor**
(`route_configs` por política), nunca aceito do corpo da requisição.

**Camada 2 — Binário (edição `managed`).** Feature do Cargo + `NEXT_PUBLIC_APP_EDITION`:
- `provider_chat*`, `provider_fetch` e o caminho BYOK **compilados fora** (ou
  condicionados à política assinada, verificada no Rust);
- fine-tuning passa a chamar os endpoints do gateway que já existem — ou é desligado;
- `gateway.baseUrl` **travado no build** (ou via política de máquina/Intune), campo
  read-only na UI;
- CSP com `connect-src` fechado no gateway (a sessão da CSP já está tratando disso);
- runtime local e o `RuntimeStatus.apiKey` (servidor em 127.0.0.1 para agentes
  externos) só existem se `localRuntime.allowed`.

**Camada 3 — UI (conveniência, não segurança).** Os 14 `Record<UiMode,…>` continuam
**totais** — a exaustividade em compile-time é o que pegou os 14 pontos na remoção do
Game. O subconjunto entra só nos ~7 pontos de **iteração** (abas, rail, Configurações),
derivado de `allowedModes ∩ preferência local`. A view não liberada **nem monta**
(gate no render, não em `useEffect`). Seções de política nas Configurações viram
read-only ou somem conforme o papel.

### 4. SSO e grupos — com a correção do Entra

O `oidc_login` atual é um proxy de cliente confidencial e **não fecha com o Entra**:
loopback só é aceito na plataforma "Mobile and desktop" (public client, que **rejeita**
`client_secret`); a plataforma "Web" aceita segredo mas não aceita `http://127.0.0.1`.

Correção:
- **Public client + PKCE**, redirect `http://localhost/callback` (o Entra casa host e
  path; o código hoje usa `127.0.0.1:{porta}/callback`);
- o desktop troca o code **direto com o IdP** (sem `client_secret`); o gateway apenas
  **valida** o token (JWKS, `iss`/`aud`/`exp`) e emite uma **sessão própria curta** —
  é ela que carrega a versão da política e permite revogação imediata;
- `scope` explícito também no **refresh** (refresh token do Entra é multi-recurso;
  sem scope o `aud` do token renovado não é garantido) e tratamento de 401 em
  execução (hoje `oidc_restore` roda uma vez no mount e nunca renova);
- **App roles em vez do claim `groups`**: a Microsoft recomenda, e o claim de grupos
  estoura em overage acima de ~150 grupos (exigiria Graph). O admin mapeia grupo do
  AD → app role no Entra (uma vez), e o token chega com `roles` — limitado, sem
  overage. No console, o admin mapeia role → módulos.

### 5. Console do admin

Sem app novo: **endpoints de administração no gateway** (`/v1/admin/groups`,
`/v1/admin/policies`, `/v1/admin/prompt-master`), autorizados **no servidor** por
`role ∈ {owner, admin}`. O app desktop mostra a seção "Administração" apenas quando o
bootstrap diz `role: admin` — mas a autorização real é a do endpoint, nunca a da UI.

### 6. Publicação: um monorepo, duas edições

O monorepo continua único (não há precedente de feature flag no projeto — este é o
primeiro). O CI produz:

| Edição | O que é | Onde vai |
| --- | --- | --- |
| `full` | tudo ligado, sem gating | uso interno de teste (o "app completo") |
| `managed` | camada 2 ativa, BYOK/local por política, baseUrl travado | estações dos usuários |
| `server` | gateway + migrations + console admin | VPS corporativo |

No GitHub, `server` e `client` saem como artefatos/releases separados do mesmo
repositório — `git subtree` só se um dia for preciso repositório separado de verdade.

### 7. Prompt master e memória

- Ordem no `buildSystemMessages`: **prompt master do servidor primeiro**, prompt
  local depois (só se `allowLocalAppend`, cortado em `localMaxChars`), e então o
  resto (memória, regras do projeto, contexto de aba). Servidor manda em conflito.
- **Memória permanece local por cliente** (pedido explícito), com duas ressalvas de
  LGPD registradas: `retentionDays` na política para expiração, e o alerta de que
  memória local com dado corporativo fica fora do backup/auditoria central —
  `memory.scope: "server"` fica reservado no contrato para o futuro.
- **Auditoria**: com BYOK/local desligados por política na edição managed, todo
  tráfego de modelo passa pelo gateway → `usage_events` por usuário/módulo volta a
  ser trilha completa (hoje BYOK/local apagam a trilha).

## Sequência de implementação

A ordem importa — enforcement antes de aparência:

1. **S1 — Contrato de wire:** `Office`/`Tune` no enum `Mode`, migration nova do CHECK,
   fim da reescrita `office→chat` no `engine.ts`. Sem isso o servidor não consegue
   nem nomear o que deve bloquear.
2. **S2 — Política no servidor:** migration 0004, `policy.rs`, `GET /v1/bootstrap`
   (ainda sem assinatura), e o **404 por módulo em todos os endpoints de execução**.
   A partir daqui o `curl` já não fura.
3. **S3 — Cliente gerenciado:** assinatura Ed25519 obrigatória + verificação no Rust,
   cache no keyring, edição `managed` (comandos compilados fora, baseUrl travado,
   CSP), UI derivada de `allowedModes`.
4. **S4 — SSO correto:** public client + `localhost/callback` + app roles + sessão
   própria do gateway + refresh com scope + tratamento de 401.
5. **S5 — Console admin + prompt master + edições no CI.**

## O que explicitamente NÃO fazer

- **Não** reusar `visibleModes` como canal de política — é preferência do usuário.
- **Não** aceitar assinatura opcional no bootstrap.
- **Não** confiar em esconder botão: `allowLocalEngineOverride: false` sem a camada 2
  só remove a UI; o `EngineSelection` persistido continua sendo honrado pelo motor.
- **Não** editar migrations aplicadas (checksum do sqlx) — sempre migration nova.
- **Não** quebrar os `Record<UiMode,…>` totais — o gating é na iteração, não no tipo.

## Pendências que dependem de TI/SI

- Registro do aplicativo no Entra (plataforma public client, redirect, app roles) —
  configuração de portal que só o admin do tenant faz.
- `pubkey` do updater e chave de assinatura da política: geração e guarda das chaves
  privadas (cofre corporativo), publicação das públicas no binário.
- Aprovação da edição `managed` como mudança de distribuição de software.
