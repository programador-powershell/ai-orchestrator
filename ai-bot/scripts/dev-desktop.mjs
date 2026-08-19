/**
 * Sobe o app desktop em desenvolvimento COM o gateway do lado.
 *
 * Por que este script existe, e não um `&&` no package.json: em produção o
 * empacotamento deixa o `aibotd` ao lado do executável, e é lá que o Rust o
 * procura primeiro (`src-tauri/src/gateway.rs`, `find_binary`). Em
 * desenvolvimento não existe esse "ao lado": o executável é o debug do cargo,
 * numa pasta de build. O segundo lugar procurado é o PATH — então o caminho
 * honesto é compilar o gateway e ACRESCENTAR `dist/` ao PATH do processo que
 * sobe o Tauri, em vez de pedir para a pessoa copiar o binário na mão e
 * descobrir sozinha por que a janela abre sem conexão.
 *
 * O `-o dist/` com barra no fim não é estilo: com um caminho de ARQUIVO o Go
 * grava exatamente aquele nome, e no Windows sai um `aibotd` sem `.exe` que o
 * Rust não encontra — o app abria dizendo "não encontrei o gateway". Com a
 * PASTA, o Go escolhe o nome certo para o sistema.
 */
import { spawn } from "node:child_process";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(raiz, "dist");

const rodar = (comando, args, extra = {}) =>
  new Promise((ok, falhou) => {
    const filho = spawn(comando, args, { cwd: raiz, stdio: "inherit", shell: true, ...extra });
    filho.on("error", falhou);
    filho.on("exit", (codigo) =>
      codigo === 0 ? ok() : falhou(new Error(`${comando} saiu com código ${codigo}`))
    );
  });

console.log("[dev:desktop] compilando o gateway em dist/…");
await rodar("go", ["build", "-C", "services/gateway", "-o", "../../dist/", "./cmd/aibotd"]);

console.log("[dev:desktop] subindo o Tauri com dist/ no PATH");
await rodar("corepack", ["pnpm", "--filter", "@aibot/desktop", "tauri", "dev"], {
  env: { ...process.env, PATH: `${dist}${delimiter}${process.env.PATH ?? ""}` }
});
