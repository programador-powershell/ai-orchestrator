/**
 * Ferramentas de "computer use" do agente — confinadas ao sandbox.
 *
 * O agente ganha continuidade real: escreve um script, roda, lê a saída,
 * corrige e roda de novo. Tudo dentro de uma SESSÃO — um diretório criado no
 * início e removido no fim — e toda execução passa pelo Job Object
 * (src-tauri/jail.rs), que encerra a árvore inteira de processos.
 *
 * ## O que o agente NÃO recebe
 *
 * Nenhum caminho absoluto. As ferramentas falam em caminho relativo à sessão;
 * quem resolve para um caminho real é o Rust (`workspace.rs`), que recusa
 * `..`, raiz e link simbólico apontando para fora. Se o agente recebesse um
 * caminho, bastaria pedir a pasta do usuário para sair da caixa.
 *
 * ## O limite, dito com todas as letras
 *
 * Isto confina CAMINHO e encerra PROCESSO. Não reduz privilégio: o comando
 * roda com o token do usuário e alcança a rede. Por isso `computer_exec` exige
 * aprovação humana a cada chamada — é a única barreira contra um comando que o
 * confinamento de caminho não impede.
 */
import { invoke } from "@tauri-apps/api/core";
import type { ToolResult, ToolSpec } from "./agent";

export const COMPUTER_TOOLS: ToolSpec[] = [
  {
    name: "computer_write",
    description: "Grava um arquivo na área de trabalho isolada (caminho relativo à sessão)",
    mutating: false,
    args: '{"path":"script.py","content":"…"}'
  },
  {
    name: "computer_read",
    description: "Lê um arquivo da área de trabalho isolada",
    mutating: false,
    args: '{"path":"saida.txt"}'
  },
  {
    name: "computer_list",
    description: "Lista a área de trabalho isolada",
    mutating: false,
    args: '{"sub":"subpasta"}'
  },
  {
    name: "computer_exec",
    description: "Executa um comando NA ÁREA ISOLADA (pede aprovação a cada chamada)",
    mutating: true,
    args: '{"command":"python script.py"}'
  }
];

export const COMPUTER_TOOL_NAMES = new Set(COMPUTER_TOOLS.map((spec) => spec.name));

interface SandboxSession {
  id: string;
  displayPath: string;
}

interface SandboxEntry {
  name: string;
  isDir: boolean;
  size: number;
}

interface SandboxRun {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  jailed: boolean;
}

export function openSession(): Promise<SandboxSession> {
  return invoke<SandboxSession>("sandbox_open");
}

export function closeSession(session: string): Promise<void> {
  return invoke("sandbox_close", { session });
}

const asText = (value: unknown): string => (typeof value === "string" ? value : "");

/**
 * Instrução que ensina o agente a usar a área isolada — e o que ela NÃO é.
 *
 * A segunda parte importa tanto quanto a primeira: sem ela o modelo tenta
 * caminho absoluto, apanha do erro e gasta voltas até desistir.
 */
export function computerUseInstruction(): string {
  const lista = COMPUTER_TOOLS.map((spec) => `- ${spec.name}: ${spec.description}. args: ${spec.args}`).join("\n");
  return (
    "Você tem uma ÁREA DE TRABALHO ISOLADA, própria desta execução, para escrever e rodar código:\n" +
    lista +
    "\n\nRegras da área:\n" +
    "- Caminhos são SEMPRE relativos à sessão. Caminho absoluto e `..` são recusados.\n" +
    "- Os arquivos PERSISTEM entre chamadas: escreva o script, execute, leia a saída e corrija.\n" +
    "- A área é apagada ao fim da execução — o que precisa sobreviver deve ser dito na resposta.\n" +
    "- `computer_exec` pede aprovação de uma pessoa a CADA chamada. Agrupe o trabalho num script " +
    "em vez de disparar muitos comandos soltos.\n" +
    "- O comando roda com o `cmd.exe` do Windows, com PATH mínimo e sem as variáveis do usuário."
  );
}

/**
 * Executa uma ferramenta de computer use. Nunca lança: a falha vira texto para
 * o modelo, que é quem decide o próximo passo.
 */
export async function dispatchComputerTool(
  tool: string,
  args: Record<string, unknown>,
  session: string
): Promise<ToolResult> {
  if (!session) {
    return { ok: false, output: "nenhuma área de trabalho isolada foi aberta para esta execução" };
  }
  try {
    switch (tool) {
      case "computer_write": {
        const path = asText(args.path).trim();
        if (!path) return { ok: false, output: 'argumento "path" é obrigatório' };
        const output = await invoke<string>("sandbox_write", {
          session,
          path,
          content: asText(args.content)
        });
        return { ok: true, output };
      }
      case "computer_read": {
        const path = asText(args.path).trim();
        if (!path) return { ok: false, output: 'argumento "path" é obrigatório' };
        return { ok: true, output: await invoke<string>("sandbox_read", { session, path }) };
      }
      case "computer_list": {
        const entries = await invoke<SandboxEntry[]>("sandbox_list", {
          session,
          sub: asText(args.sub).trim() || null
        });
        if (!entries.length) return { ok: true, output: "(vazio)" };
        return {
          ok: true,
          output: entries
            .map((entry) => (entry.isDir ? `${entry.name}/` : `${entry.name} (${entry.size} B)`))
            .join("\n")
        };
      }
      case "computer_exec": {
        const command = asText(args.command).trim();
        if (!command) return { ok: false, output: 'argumento "command" é obrigatório' };
        const run = await invoke<SandboxRun>("sandbox_execute", {
          command,
          cwd: null,
          session,
          timeoutMs: 30_000
        });
        return { ok: run.exitCode === 0, output: formatRun(run) };
      }
      default:
        return { ok: false, output: `ferramenta desconhecida: ${tool}` };
    }
  } catch (cause) {
    return { ok: false, output: cause instanceof Error ? cause.message : String(cause) };
  }
}

/** Saída para o modelo: código, stdout e stderr separados e rotulados. */
function formatRun(run: SandboxRun): string {
  const partes = [`saída ${run.exitCode ?? "?"} · ${Math.round(run.durationMs)}ms`];
  if (run.stdout.trim()) partes.push(`stdout:\n${run.stdout.trim()}`);
  if (run.stderr.trim()) partes.push(`stderr:\n${run.stderr.trim()}`);
  if (!run.jailed) {
    // Nunca deveria acontecer no Windows; se acontecer, o modelo (e o log)
    // precisam saber que a garantia de encerramento não valeu.
    partes.push("aviso: este comando rodou SEM Job Object — a árvore de processos não é garantida");
  }
  if (partes.length === 1) partes.push("(sem saída)");
  return partes.join("\n\n");
}
