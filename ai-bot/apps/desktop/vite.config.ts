import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
// defineConfig vem do vitest, e não do vite, só para o bloco `test` abaixo ser
// tipado. É o mesmo defineConfig do Vite reexportado com a chave a mais.
import { defineConfig } from "vitest/config";

/**
 * O alias precisa de caminho ABSOLUTO: o Vite passa o valor do alias direto para
 * o resolver e não normaliza caminho relativo — "../../packages/..." entraria
 * como texto e quebraria dependendo de quem importa.
 */
const contractsEntry = fileURLToPath(
  new URL("../../packages/contracts/src/index.ts", import.meta.url)
);

export default defineConfig({
  plugins: [react()],

  server: {
    /*
     * Porta FIXA, e strictPort obrigatório.
     *
     * O Tauri não descobre o dev server: o `devUrl` do tauri.conf.json aponta
     * para http://localhost:1421 e é isso que a janela carrega. Sem strictPort
     * o Vite "resolve" uma porta ocupada pulando para 1422 e imprime um aviso
     * discreto no terminal — a janela do Tauri então abre BRANCA, sem erro de
     * console, sem erro de Rust, e a investigação vai parar no lugar errado.
     * Com strictPort o Vite falha alto e a causa aparece na primeira linha.
     *
     * Se mudar a porta aqui, mude junto em src-tauri/tauri.conf.json.
     */
    port: 1421,
    strictPort: true,
    watch: {
      // O cargo reescreve src-tauri/target o tempo todo; sem ignorar, o HMR
      // entra em laço de recarga durante cada build do Rust.
      ignored: ["**/src-tauri/**"]
    }
  },

  // O Tauri escreve o log do Rust no MESMO terminal do Vite. Limpar a tela a
  // cada rebuild engole o erro de compilação que acabou de subir.
  clearScreen: false,

  // TAURI_* é injetado pela CLI do Tauri (plataforma, arch, versão do app) e
  // precisa atravessar para o cliente junto com o VITE_* de sempre.
  envPrefix: ["VITE_", "TAURI_"],

  build: {
    // A única engine que roda este bundle é a WebView do Tauri 2 (WebView2 no
    // Windows). Mirar em chrome120 evita transpilar e polir para navegador
    // antigo que nunca vai abrir o app.
    target: "chrome120"
  },

  resolve: {
    alias: {
      // Aponta para o FONTE do pacote, não para um dist: o contrato muda junto
      // com o gateway e ter que buildar packages/contracts a cada ajuste é
      // exatamente o atrito que faz o contrato ficar desatualizado.
      "@aibot/contracts": contractsEntry
    }
  },

  test: {
    environment: "jsdom",
    globals: false,
    include: ["src/**/*.test.{ts,tsx}"]
  }
});
