"""Launcher do soup EMBUTIDO no AI Orchestrator.

Roda a copia vendorizada do soup-cli (Apache-2.0) direto da fonte — nada e
instalado via pip. Funciona nos dois layouts:
  - repositorio:  third_party/soup/src/soup_cli
  - app empacotado (recursos Tauri): third_party/soup/src/soup_cli

Requisitos de runtime (Python + dependencias do soup) sao do ambiente do
usuario; se faltarem, o erro real aparece na conversa da aba Fine-Tuning.
"""
import os
import sys

base = os.path.dirname(os.path.abspath(__file__))
for candidate in (os.path.join(base, "src"), base):
    if os.path.isdir(os.path.join(candidate, "soup_cli")):
        sys.path.insert(0, candidate)
        break

from soup_cli.cli import run

run()
