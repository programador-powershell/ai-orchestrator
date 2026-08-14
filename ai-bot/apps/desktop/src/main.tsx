import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App";
import "./styles/index.css";

const host = document.getElementById("root");

// Falhar aqui é falhar cedo: sem #root o React montaria em lugar nenhum e a
// janela do Tauri abriria branca, que é o sintoma mais caro de investigar
// neste app (não gera erro de Rust nem de rede).
if (!host) {
  throw new Error("index.html sem <div id=\"root\">: a aplicação não tem onde montar.");
}

createRoot(host).render(
  <StrictMode>
    <App />
  </StrictMode>
);
