// Script de build do Tauri.
//
// Parece decorativo e não é. `tauri_build::build()` faz três coisas das quais o
// aplicativo depende para sequer abrir:
//
//  1. Gera o contexto que `tauri::generate_context!()` consome em lib.rs
//     (tauri.conf.json compilado, ativos do frontend, esquemas das
//     capabilities). Sem isso o macro não tem o que expandir.
//  2. Embute o manifesto de aplicação e o ícone no executável do Windows.
//  3. Calcula os hashes `sha256-` dos scripts INLINE do index.html e os injeta
//     na CSP declarada em tauri.conf.json. Este passo SÓ acontece quando
//     `security.csp` é não-nulo — e é justamente por isso que ele importa aqui:
//     nosso `script-src` é `'self'`, sem `'unsafe-inline'`, então um script
//     inline que apareça no HTML depende deste cálculo para continuar rodando.
//     Sem tauri-build, a janela abriria branca e sem erro de Rust nem de rede.
fn main() {
    tauri_build::build()
}
