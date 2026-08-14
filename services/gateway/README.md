# Gateway do Multiplike-AI

API multiworkspace em Rust/Axum. O gateway mantém chaves de provedores somente no
servidor, criptografadas com AES-256-GCM, e nunca persiste prompts ou respostas.

## Provedores do MVP

OpenAI, Anthropic, Gemini, Moonshot, DeepSeek, Mistral, endpoint OpenAI-compatible,
OpenAI Images, Google Imagen e Black Forest Labs/Flux.

## Ambiente local

1. Defina `PROVIDER_MASTER_KEY` como Base64 de 32 bytes.
2. Configure o OIDC genérico em `.env`.
3. Execute `docker compose up --build`.

O serviço aplica as migrations ao iniciar e publica `/health` e `/metrics`. Para
OpenShip, importe `services/gateway` como raiz do projeto; TLS, health-gated rollout e
rollback ficam a cargo do ambiente de implantação.

## Captura de design

`POST /v1/workspaces/{workspace}/design/replications` recebe `sourceUrl`, `mode`
(`static`) e `maxPages`. A análise estática segue o mesmo princípio do SkillUI:
extrai a linguagem visual antes da geração, incluindo cores, variáveis CSS,
tipografia, sinais de layout, componentes semânticos, keyframes e páginas internas.

A captura rejeita redes locais/privadas, revalida cada redirecionamento, aceita
somente HTML e limita a resposta de origem a 2 MiB. O modo `ultra` está reservado
para o worker de navegador isolado, que acrescentará screenshots, estados de hover,
diffs de interação e análise visual sem instalar Node ou Playwright no computador do
usuário.
