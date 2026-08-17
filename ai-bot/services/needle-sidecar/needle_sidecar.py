#!/usr/bin/env python3
"""Degrau local do AI-BOT: escolhe o dono do PRIMEIRO input de uma conversa.

Este processo é falado pelo gateway Go por stdin/stdout, uma linha JSON por
pergunta (ver internal/needle/sidecar.go). Ele não conversa com a pessoa, não
executa ferramenta e não responde pedido nenhum — devolve um id de especialista
e uma confiança, e só.

Por que um processo em vez de cgo: o motor do Needle é um binário C++ que o
pacote `cactus-needle` baixa e opera; ligá-lo por cgo exigiria toolchain C em
toda máquina que compila o gateway, e o header C vive noutro projeto, com
licença própria. Aqui o custo é um IPC por decisão — microssegundos ao lado dos
segundos que o modelo grande cobraria.

    pip install cactus-needle
    needle fetch                       # baixa o binário de ~14 MB, uma vez
    AIBOT_NEEDLE_CMD="python /caminho/needle_sidecar.py" ./aibotd

PROTOCOLO
    saudação (nós → gateway, uma vez):  {"specialist":"","confidence":0}
    ou, se não der para subir:          {"error":"<motivo>"}
    pergunta (gateway → nós):           {"prompt":"...","candidates":["code",...]}
    resposta (nós → gateway):           {"specialist":"code","confidence":0.9,"why":"..."}
    ou:                                 {"error":"<motivo>"}

REGRAS QUE O GATEWAY CONFERE, e que este script não deve violar:
  * o `specialist` devolvido TEM de estar em `candidates` — a lista muda por
    política e por conversa, e um id de fora seria um especialista que a sessão
    não liberou atendendo a pessoa;
  * `confidence` fica em [0,1];
  * uma resposta por pergunta, na ordem — o gateway pergunta uma de cada vez;
  * stdout é SÓ protocolo. Qualquer `print` de diagnóstico vai para stderr, que
    o gateway encaminha para o log dele. Um print perdido no stdout vira uma
    linha ilegível e a decisão daquele turno é descartada.
"""

from __future__ import annotations

import json
import os
import sys


def responder(payload: dict) -> None:
    """Escreve UMA linha de protocolo e força a descarga.

    O flush não é zelo: stdout de processo filho é bufferizado por bloco, e sem
    ele a resposta ficaria presa no buffer até encher — o gateway estouraria o
    prazo de 3 s e concluiria, com razão, que o sidecar não responde.
    """
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def log(mensagem: str) -> None:
    print(f"[needle-sidecar] {mensagem}", file=sys.stderr, flush=True)


def carregar_modelo():
    """Abre a sessão do Needle. Devolve (modelo, erro)."""
    try:
        from needle import Needle  # type: ignore
    except ImportError as erro:
        return None, (
            f"pacote cactus-needle ausente ({erro}). "
            "Instale com: pip install cactus-needle && needle fetch"
        )

    # O caminho explícito vence, para a mesma máquina poder testar o modelo BASE
    # e o especializado do harness sem reinstalar nada.
    caminho = os.environ.get("AIBOT_NEEDLE_MODEL", "").strip()
    try:
        modelo = Needle(caminho) if caminho else Needle()
    except Exception as erro:  # noqa: BLE001 — qualquer falha aqui é "sem degrau"
        return None, f"não foi possível abrir o modelo: {erro}"
    return modelo, None


def decidir(modelo, prompt: str, candidatos: list[str], tools: list[dict]) -> dict:
    """Classifica um prompt entre os candidatos.

    Uma FERRAMENTA POR ESPECIALISTA, sem argumento: o nome da ferramenta é a
    decisão. A alternativa — uma ferramenta `route` com um enum em string —
    jogaria a escolha para um campo livre, enquanto o esquema de ferramentas
    vira gramática na decodificação e impede o modelo de inventar um id que não
    existe.
    """
    # As DESCRIÇÕES vêm do gateway, e é isso que faz especialista novo funcionar
    # sem retreinar nada: o catálogo é dado, a atualização traz gente nova nele,
    # e a descrição chega aqui em toda pergunta. Um id nu ("fluxo") não diz nada
    # a um modelo de 45 M de parâmetros — a descrição diz.
    ferramentas = [
        {
            "name": t["name"],
            "description": t.get("description") or t["name"],
            "parameters": t.get("parameters") or {"type": "object", "properties": {}},
        }
        for t in tools
    ]

    resultado = modelo.complete(prompt, tools=ferramentas)

    chamadas = getattr(resultado, "tool_calls", None) or []
    if not chamadas:
        return {"error": "o modelo não escolheu nenhum especialista"}

    escolhido = getattr(chamadas[0], "name", None) or chamadas[0].get("name", "")
    if escolhido not in candidatos:
        return {"error": f"o modelo devolveu {escolhido!r}, fora dos candidatos"}

    # A confiança do próprio modelo quando ela existe. O Needle 2.0.5 desabilita
    # a confiança calibrada em pesos LoRA — por isso o portão de verdade é o
    # limiar do lado do Go (NeedleMinConfidence), e não este número.
    confianca = getattr(resultado, "confidence", None)
    if not isinstance(confianca, (int, float)):
        confianca = 1.0
    confianca = max(0.0, min(1.0, float(confianca)))

    return {"specialist": escolhido, "confidence": confianca, "why": "roteador local"}


def main() -> int:
    modelo, erro = carregar_modelo()
    if erro:
        log(erro)
        responder({"error": erro})
        return 1

    log("modelo carregado; aguardando perguntas")
    responder({"specialist": "", "confidence": 0})

    for linha in sys.stdin:
        linha = linha.strip()
        if not linha:
            continue
        try:
            pedido = json.loads(linha)
        except json.JSONDecodeError as falha:
            responder({"error": f"pedido ilegível: {falha}"})
            continue

        candidatos = [str(c) for c in pedido.get("candidates", []) if str(c).strip()]
        if not candidatos:
            responder({"error": "pedido sem candidatos"})
            continue

        # Sem `tools` (gateway antigo), cai no id nu — funciona, decide pior, e
        # é melhor que recusar a pergunta.
        tools = pedido.get("tools") or [
            {"name": c, "description": f"Especialista {c}."} for c in candidatos
        ]

        try:
            responder(decidir(modelo, str(pedido.get("prompt", "")), candidatos, tools))
        except Exception as falha:  # noqa: BLE001
            # NUNCA morrer por uma pergunta. O gateway trata o erro como "pule o
            # degrau" e segue para o modelo grande; derrubar o processo custaria
            # o carregamento do modelo de novo na próxima.
            log(f"falha ao decidir: {falha}")
            responder({"error": str(falha)})

    return 0


if __name__ == "__main__":
    sys.exit(main())
