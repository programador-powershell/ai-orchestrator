/**
 * fsx — cliente do sistema de arquivos do projeto (comandos Rust fs_*).
 * No navegador (ou quando o comando não existe nesta build) cai em modo
 * demonstração claramente rotulado, com uma árvore que espelha o monorepo,
 * para a UI permanecer 100% navegável.
 */
import { invoke } from "@tauri-apps/api/core";
import type { FsEntry } from "@orchestrator/contracts";
import { currentRoute, ssh, toTarget, type SshTarget } from "./ssh";

const isTauriHost = "__TAURI_INTERNALS__" in window;

/** true quando o filesystem é o real (Tauri); false = árvore demo no navegador. */
export const isTauriFs = isTauriHost;

const dir = (path: string): FsEntry => ({ name: path.split("/").pop() ?? path, path, isDir: true, size: 0 });
const file = (path: string, size: number): FsEntry => ({
  name: path.split("/").pop() ?? path,
  path,
  isDir: false,
  size
});

/** Árvore demo — espelha o próprio repositório (apps/, packages/, services/). */
const demoTree: Record<string, FsEntry[]> = {
  "": [
    dir("apps"),
    dir("packages"),
    dir("services"),
    file("package.json", 512),
    file("pnpm-workspace.yaml", 96),
    file("README.md", 2048)
  ],
  apps: [dir("apps/desktop")],
  "apps/desktop": [
    dir("apps/desktop/src"),
    dir("apps/desktop/src-tauri"),
    file("apps/desktop/package.json", 1180),
    file("apps/desktop/vite.config.ts", 340)
  ],
  "apps/desktop/src": [
    dir("apps/desktop/src/components"),
    dir("apps/desktop/src/lib"),
    dir("apps/desktop/src/modes"),
    dir("apps/desktop/src/styles"),
    file("apps/desktop/src/App.tsx", 9400),
    file("apps/desktop/src/main.tsx", 420),
    file("apps/desktop/src/styles.css", 260)
  ],
  "apps/desktop/src/components": [
    file("apps/desktop/src/components/CodeEditor.tsx", 3600),
    file("apps/desktop/src/components/Composer.tsx", 11200),
    file("apps/desktop/src/components/Primitives.tsx", 4200)
  ],
  "apps/desktop/src/lib": [
    file("apps/desktop/src/lib/engine.ts", 8800),
    file("apps/desktop/src/lib/fsx.ts", 5200),
    file("apps/desktop/src/lib/store.ts", 6800),
    file("apps/desktop/src/lib/terminal.ts", 520)
  ],
  "apps/desktop/src/modes": [file("apps/desktop/src/modes/CodeView.tsx", 15400)],
  "apps/desktop/src/styles": [
    file("apps/desktop/src/styles/glass.css", 6900),
    file("apps/desktop/src/styles/tokens.css", 5400),
    file("apps/desktop/src/styles/views.css", 9800)
  ],
  "apps/desktop/src-tauri": [file("apps/desktop/src-tauri/tauri.conf.json", 1300)],
  packages: [dir("packages/contracts")],
  "packages/contracts": [dir("packages/contracts/src"), file("packages/contracts/package.json", 380)],
  "packages/contracts/src": [file("packages/contracts/src/index.ts", 7600)],
  services: [dir("services/gateway")],
  "services/gateway": [dir("services/gateway/src"), file("services/gateway/Cargo.toml", 640)],
  "services/gateway/src": [file("services/gateway/src/main.rs", 12400)]
};

const demoFiles: Record<string, string> = {
  "README.md":
    "# AI-Orchestrator\n\nConteúdo de demonstração — no aplicativo desktop o explorer lê os arquivos reais\n" +
    "através dos comandos nativos fs_list / fs_read / fs_write.\n",
  "packages/contracts/src/index.ts":
    'export const MODES = ["chat", "work", "design", "data", "agent", "code", "security"] as const;\n' +
    "export type Mode = (typeof MODES)[number];\n\n" +
    "export interface FsEntry {\n  name: string;\n  path: string;\n  isDir: boolean;\n  size: number;\n}\n",
  "apps/desktop/src/lib/fsx.ts":
    '// Cliente do sistema de arquivos com fallback web (você está lendo a versão demo).\nexport {};\n'
};

function normalizePath(value: string): string {
  return value
    .replace(/\\/g, "/")
    .replace(/^\.\/?/, "")
    .replace(/^\/+|\/+$/g, "");
}

function sortEntries(entries: FsEntry[]): FsEntry[] {
  return [...entries].sort((a, b) =>
    a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1
  );
}

function demoFallbackContent(path: string): string {
  const name = path.split("/").pop() ?? path;
  const banner = `Conteúdo de demonstração de ${name} — o desktop lê o arquivo real via fs_read.`;
  if (name.endsWith(".css")) return `/* ${banner} */\n\n.exemplo {\n  color: var(--ink);\n}\n`;
  if (name.endsWith(".md")) return `# ${name}\n\n${banner}\n`;
  if (name.endsWith(".json")) return `{\n  "demo": true,\n  "arquivo": "${name}"\n}\n`;
  if (name.endsWith(".rs")) return `// ${banner}\nfn main() {\n    println!(\"demo\");\n}\n`;
  if (name.endsWith(".toml") || name.endsWith(".yaml") || name.endsWith(".yml")) {
    return `# ${banner}\ndemo = true\n`;
  }
  return `// ${banner}\nexport {};\n`;
}

/**
 * O projeto SEGUE o ambiente selecionado.
 *
 * Rotear só o terminal era pior que não rotear nada: no ambiente VPS o agente
 * rodava o build no servidor e lia/gravava os arquivos no disco da estação —
 * montava aqui e compilava lá, sem ninguém perceber. Arquivo e comando
 * precisam ver a MESMA máquina.
 *
 * O que não segue, e por quê: documento do Office, mídia de vídeo e dataset de
 * treino são arquivos da pessoa, não do projeto — eles não estão no servidor, e
 * transferir binário por este caminho de texto os corromperia.
 */
function remoteTarget(): SshTarget | null {
  if (!isTauriHost) return null;
  const rota = currentRoute();
  /**
   * Rota BLOQUEADA falha alto — não cai para o disco local.
   *
   * Com o ambiente em VPS e nenhum servidor habilitado (ou dois), o terminal
   * já recusava o comando com o motivo, mas o explorador e o agente seguiam
   * lendo e GRAVANDO na estação achando que estavam no servidor: a mesma
   * inconsistência "monta aqui e compila lá" que este módulo existe para
   * eliminar, só que silenciosa.
   */
  if (rota.kind === "blocked") throw new Error(rota.reason);
  return rota.kind === "ssh" ? toTarget(rota.server) : null;
}

/** Lista o conteúdo de uma subpasta da raiz do projeto. */
export async function fsList(root: string, sub: string): Promise<FsEntry[]> {
  const remoto = remoteTarget();
  if (remoto) return sortEntries(await ssh.list(remoto, sub));
  if (isTauriHost) {
    try {
      return sortEntries(await invoke<FsEntry[]>("fs_list", { root, sub }));
    } catch {
      // Comando indisponível nesta build → segue para o modo demonstração.
    }
  }
  return sortEntries(demoTree[normalizePath(sub)] ?? []);
}

/** Lê um arquivo relativo à raiz do projeto. */
export async function fsRead(root: string, path: string): Promise<string> {
  const remoto = remoteTarget();
  if (remoto) return ssh.read(remoto, path);
  if (isTauriHost) {
    try {
      return await invoke<string>("fs_read", { root, path });
    } catch {
      // Comando indisponível nesta build → segue para o modo demonstração.
    }
  }
  const key = normalizePath(path);
  return demoFiles[key] ?? demoFallbackContent(key);
}

/** Diretórios pesados/gerados ignorados na indexação (Quick Open / busca). */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "target",
  ".next",
  ".venv",
  "__pycache__",
  "coverage"
]);

export interface CollectOptions {
  /** Máximo de arquivos coletados (padrão 500). */
  maxEntries?: number;
  /** Profundidade máxima de diretórios (padrão 4; raiz = 0). */
  maxDepth?: number;
}

/**
 * Coleta recursivamente (BFS) os arquivos do projeto via fsList, com limites
 * de profundidade e quantidade para não travar em repositórios grandes.
 */
export async function collectFiles(root: string, options: CollectOptions = {}): Promise<FsEntry[]> {
  const maxEntries = options.maxEntries ?? 500;
  const maxDepth = options.maxDepth ?? 4;
  const files: FsEntry[] = [];
  const queue: Array<{ sub: string; depth: number }> = [{ sub: "", depth: 0 }];
  while (queue.length && files.length < maxEntries) {
    const { sub, depth } = queue.shift()!;
    const entries = await fsList(root, sub).catch(() => [] as FsEntry[]);
    for (const entry of entries) {
      if (entry.isDir) {
        if (depth + 1 <= maxDepth && !SKIP_DIRS.has(entry.name)) {
          queue.push({ sub: entry.path, depth: depth + 1 });
        }
      } else {
        files.push(entry);
        if (files.length >= maxEntries) break;
      }
    }
  }
  return files;
}

/** Grava um arquivo relativo à raiz do projeto. No navegador é um no-op. */
export async function fsWrite(root: string, path: string, content: string): Promise<void> {
  const remoto = remoteTarget();
  if (remoto) {
    await ssh.write(remoto, path, content);
    return;
  }
  if (isTauriHost) {
    await invoke("fs_write", { root, path, content });
    return;
  }
  // Web: nada é persistido fora do desktop (demonstração).
  void content;
}

/**
 * Apaga um arquivo do projeto. Segue o ambiente, como o resto do módulo.
 *
 * Serve para limpar o que o app cria e não é do usuário (o temporário do
 * terminal), não para o agente remover arquivo — isso continua não existindo
 * como ferramenta.
 */
export async function fsRemove(root: string, path: string): Promise<void> {
  const remoto = remoteTarget();
  if (remoto) {
    await ssh.exec(remoto, `rm -f -- ${JSON.stringify(path)}`);
    return;
  }
  if (isTauriHost) await invoke("fs_remove", { root, path });
}
