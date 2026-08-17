# Degrau local por processo (sidecar Python)

O segundo degrau da cascata de roteamento — o modelo pequeno que decide o dono
do **primeiro input** quando o léxico não decidiu e antes de gastar o modelo
grande.

## Por que um processo, e não cgo

A rota nativa (`internal/needle/needle_shim.c`) esbarrou em duas paredes que não
são técnicas:

- o motor C do Needle vive num **projeto à parte** (`cactus-compute/cactus`),
  com licença própria e header `cactus_engine.h` — o shim tinha sido escrito
  contra uma API `needle_*` que não existe;
- ligar a tag `-tags needle` exige **toolchain C em toda máquina que compila** o
  gateway.

O caminho por Python contorna as duas: `pip install cactus-needle` e
`needle fetch` trazem um binário único de ~14 MB com **modelo, tokenizer e
engine selados dentro**. O custo é um processo a mais e um IPC por decisão —
microssegundos, ao lado dos segundos que o modelo grande cobraria.

E, o que mais importa na prática: **o degrau passa a existir no binário normal**.
Sem tag de build, sem cgo, sem recompilar nada.

## Instalação

```bash
python3 -m venv .venv
.venv/bin/pip install cactus-needle
.venv/bin/needle fetch          # baixa o binário do modelo, uma vez
```

E no gateway:

```bash
export AIBOT_NEEDLE_CMD="/caminho/.venv/bin/python /caminho/needle_sidecar.py"
# opcional: um .cact específico (o especializado do harness, por exemplo)
export AIBOT_NEEDLE_MODEL="$APPDATA/AI-BOT/models/needle-router-pro.cact"
./aibotd
```

No log de subida, a diferença aparece assim:

```
roteador local pronto (processo)   comando=…/python …/needle_sidecar.py
```

Se o sidecar não subir, o log diz **por quê** e o gateway segue sem ele — o
primeiro input vai do fast router direto ao modelo grande. O degrau é opcional
por desenho: ele acelera, e nunca é o motivo de a conversa não andar.

## Protocolo

Uma linha JSON por mensagem, em `stdin`/`stdout`. `stdout` é **só protocolo**:
qualquer diagnóstico vai para `stderr`, que o gateway encaminha ao log dele.

| sentido | quando | linha |
| --- | --- | --- |
| sidecar → gateway | uma vez, ao subir | `{"specialist":"","confidence":0}` |
| sidecar → gateway | se não conseguiu subir | `{"error":"<motivo>"}` |
| gateway → sidecar | por pergunta | `{"prompt":"…","candidates":["code","data"]}` |
| sidecar → gateway | por resposta | `{"specialist":"code","confidence":0.9,"why":"…"}` |
| sidecar → gateway | quando não decidir | `{"error":"<motivo>"}` |

O gateway **confere** o que volta: o `specialist` tem de estar em `candidates`
(a lista muda por política e por conversa — um id de fora seria um especialista
que a sessão não liberou atendendo a pessoa) e a confiança tem de ficar em
`[0,1]`. Além disso há o limiar `NeedleMinConfidence` (0,78, calibrado pelo
harness): abaixo dele o veredito é descartado e a cascata segue.

## Exercitar sem Python

`cmd/fakeneedle` é um sidecar de mentira em Go que fala o mesmo protocolo. Serve
para exercitar a fiação inteira — subida do processo, aperto de mão, pergunta,
conferência da resposta, rota publicada com motivo `needle` — em máquina que não
tem Python nem o binário do modelo:

```bash
go build -o fakeneedle ./cmd/fakeneedle
AIBOT_NEEDLE_CMD="./fakeneedle" ./aibotd
```

O que ele simula é só o **cérebro**; a fiação é a mesma que o script Python usa.
