// Sem esta linha o binário de release nasce como aplicativo de CONSOLE: uma
// janela preta pisca atrás do app a cada abertura e nunca fecha. Em debug ela
// NÃO se aplica de propósito — é lá que o log do Rust e o do Vite convivem no
// mesmo terminal. Todo o resto da aplicação vive em src/lib.rs.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    aibot_desktop_lib::run();
}
