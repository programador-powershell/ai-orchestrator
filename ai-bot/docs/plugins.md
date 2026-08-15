# Plugins e perfis

O AI-BOT usa um microkernel inspirado na arquitetura do
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): o núcleo
oferece contratos pequenos, plugins contribuem capacidades e cada registro
devolve um efeito reversível. Montagem é atômica; falha numa contribuição
desfaz as anteriores na ordem inversa. Descarregar revela a camada que estava
por baixo, sem reiniciar o gateway.

O primeiro plugin embutido é `grok`. O manifesto registra o adaptador xAI sobre
o protocolo OpenAI, o provedor, `grok-4.5` e Grok Imagine. Portanto Grok não é
uma exceção no catálogo: é a primeira implementação do mesmo caminho usado por
plugins locais.

## Onde ficam

Cada plugin local ocupa uma pasta:

```text
%APPDATA%/AI-BOT/
├── plugins/
│   └── minha-integracao/
│       └── plugin.json
└── profiles/
    └── default.json
```

Descobrir uma pasta não a ativa. O perfil `default.json` é a lista auditável de
plugins habilitados:

```json
{
  "schemaVersion": 1,
  "name": "default",
  "plugins": ["grok", "minha-integracao"]
}
```

`requires` no manifesto declara dependências. O runtime resolve a ordem,
recusa ciclos e, se uma folha falhar, desmonta somente o que aquela operação
acabou de montar.

## Manifesto

```json
{
  "schemaVersion": 1,
  "name": "minha-integracao",
  "version": "1.0.0",
  "requires": [],
  "contributes": [
    {
      "kind": "mcp.server",
      "id": "acme",
      "config": {
        "name": "acme",
        "url": "https://mcp.acme.example/rpc",
        "secretRef": "mcp:acme",
        "discover": true
      }
    }
  ]
}
```

O manifesto é declarativo; ele não carrega DLL, script ou código arbitrário. Um
servidor MCP remoto vira um plugin porque seu protocolo já é a fronteira de
execução. URL externa exige HTTPS; HTTP só passa em loopback. Credenciais são
sempre referências ao cofre, nunca valores no JSON.

## Tipos de contribuição

### `llm.adapter`

Liga um `kind` comercial a um protocolo estável do roteador:

```json
{
  "kind": "llm.adapter",
  "id": "xai-openai",
  "config": {
    "kind": "xai",
    "protocol": "openai",
    "conversationHeader": "x-grok-conv-id",
    "imageProtocol": "openai"
  }
}
```

Protocolos atuais: `openai`, `anthropic` e `gemini`. Colisão de `kind` é erro;
a ordem de boot nunca escolhe silenciosamente quem recebe prompt e chave.

### `llm.catalog`

Contribui `providers` e `models` no mesmo formato de `catalog.json`. `priority`
é opcional e nasce em 10. A configuração local da pessoa fica na prioridade
100, então habilitar xAI ou trocar sua base cria um override sem editar o
manifesto. Ao descarregar o plugin, só a camada dele some.

### `mcp.server`

Registra um servidor MCP e publica cada ferramenta descoberta como
`<servidor>.<ferramenta>` no registro executável do supervisor. `tools` pode ser
declarado no manifesto para catálogo estático; `discover: true` chama
`tools/list`. O unload remove ferramentas e servidor juntos.

### `specialist.overlay`

Aplica um documento de especialistas no campo `config.overlay`. O runtime
captura o catálogo anterior e o restaura no unload, inclusive quando o estado
anterior já era outro overlay.

## Limites e compatibilidade

Os `Corporate Capability Packs` continuam aceitos como formato legado. Novos
provedores, conectores MCP e overlays devem usar plugins/perfis; assim passam
pelo ciclo de vida atômico e reversível. Ferramentas compiladas do gateway usam
o mesmo registro com dono `core`, por isso plugins não conseguem sequestrar um
nome existente.

As ideias deliberadamente reaproveitadas do DeepSeek Harness são: núcleo sem
conhecimento de implementações comerciais, definição/provedor/consumidor como
costura de capacidade, perfis como composição ordenada e efeitos reversíveis no
unload. A implementação permanece Go puro e sem dependência externa.
