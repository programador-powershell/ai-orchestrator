// O gateway do AI-BOT usa SOMENTE a biblioteca padrão.
//
// Não é ascetismo: é a política de segurança da casa aplicada onde ela custa.
// Toda dependência de terceiro no cérebro do produto teria de passar por
// análise de TI/SI (item 4 da política), e o gateway é justamente o processo
// que segura chave de provedor, executa ferramenta e fala com a rede. As três
// tentações normais foram resolvidas na mão e estão documentadas onde moram:
//
//   - WebSocket  -> internal/transport/ws.go   (RFC 6455, ~300 linhas)
//   - Banco      -> internal/store/store.go    (log append-only + fsync)
//   - JSON-RPC   -> internal/transport/acp.go  (MCP e ACP falam o mesmo dialeto)
//
// O único lugar em que a padrão não bastaria é o Job Object do Windows, que
// exigiria golang.org/x/sys — e por isso a caixa de isolamento continua no
// Rust, onde a crate já é homologada. Ver docs/arquitetura.md.
module aibot/gateway

go 1.22
