/**
 * A tela de Código COM o terminal da pessoa acoplado.
 *
 * # Por que um arquivo separado, e não uma edição em `EditorSurface.tsx`
 *
 * O `EditorSurface.tsx` é posse de outra frente de trabalho (as ondas de
 * paridade mexem nele em paralelo); editar lá seria pisar em cima. Este
 * módulo compõe sem tocar: a superfície original inteira, mais o
 * `TerminalDock` como irmão dela dentro do `.stage` (que é uma coluna flex —
 * a superfície tem `flex: 1` e encolhe, o dock é `flex: none` e ocupa o pé).
 *
 * # Como ligar (UMA linha, no Stage)
 *
 * Em `shell/Stage.tsx`, a entrada `editor` do mapa de superfícies passa a
 * importar este módulo no lugar do original:
 *
 *   editor: lazySurface("EditorSurface", () => import("../specialists/EditorSurface.terminal"))
 *
 * O `lazySurface` resolve `mod.default ?? mod["EditorSurface"]`, e este módulo
 * exporta os dois nomes — a troca funciona por qualquer um dos caminhos.
 *
 * # O que o dock NÃO muda
 *
 * O painel de "saída" do editor continua sendo o espelho do `proc.run` (o
 * caminho do MODELO, com aprovação). O dock é o caminho da PESSOA: teclado
 * direto no shell, sem portão — ver a regra de segurança no cabeçalho de
 * `shell/TerminalPanel.tsx` e de `src-tauri/src/pty.rs`.
 */

import type { ReactNode } from "react";
import { TerminalDock } from "../shell/TerminalPanel";
import { EditorSurface } from "./EditorSurface";

export function EditorSurfaceComTerminal(): ReactNode {
  return (
    <>
      <EditorSurface />
      {/* Sem `cwd`: o `pty_spawn` cai para a RAIZ DO PROJETO (a mesma de
          `tools::project_root()`, que acompanha o `set_project_root`) — o
          shell abre onde a árvore de arquivos ao lado está olhando. */}
      <TerminalDock />
    </>
  );
}

/** O nome que o `lazySurface("EditorSurface", …)` procura quando não há default. */
export { EditorSurfaceComTerminal as EditorSurface };

export default EditorSurfaceComTerminal;
