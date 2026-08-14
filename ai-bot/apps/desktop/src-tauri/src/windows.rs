//! As janelas do AI-BOT.
//!
//! A janela `main` é declarada no tauri.conf.json e sobe com o processo — hoje
//! pela mão do `create_windows` no `setup` (ver lib.rs: as duas levam
//! `"create": false` para não nascerem antes de o app decidir QUAL interface
//! carregar). A `avatars` — o laboratório onde a pessoa personaliza os bots,
//! aberta pelo ícone do AI-BOT na barra lateral — também é declarada lá, porém
//! com `visible: false`: ela nasce junto, escondida, e o clique só a mostra.
//!
//! Por que criar escondida em vez de criar sob demanda: o laboratório carrega o
//! mesmo bundle React da tela principal. Construir a janela no clique custa o
//! boot inteiro do webview (webview novo, JS baixado, React montado) com a
//! pessoa olhando para um retângulo cinza. Nascendo escondida, o clique é só um
//! `show()`.
//!
//! O caminho de criação continua existindo porque fechar uma janela no Tauri a
//! DESTRÓI — não a esconde. Depois do primeiro fechamento, `avatars` não existe
//! mais e precisa ser reconstruída.

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

/// Rótulo da janela. É a chave que o Tauri usa para achá-la e a mesma string
/// que aparece em `capabilities/default.json` e em `tauri.conf.json`; ela mora
/// numa constante para que mudá-la quebre no lugar certo e não vire uma janela
/// sem permissão nenhuma, que abre em branco e não explica o motivo.
pub const AVATAR_LAB_LABEL: &str = "avatars";

/// O `?window=avatars` é o que o `main.tsx` lê para montar o laboratório em vez
/// da tela principal. É query string e não rota porque o app é servido como
/// arquivo estático: um caminho como `/avatars` daria 404 no protocolo de asset
/// do Tauri, que não tem fallback de SPA.
const AVATAR_LAB_URL: &str = "index.html?window=avatars";

/// Título, tamanho e mínimo REPETEM o tauri.conf.json de propósito.
///
/// A duplicação incomoda menos do que a alternativa: sem ela, a janela recriada
/// depois de um fechamento sairia diferente da que nasceu com o app — outro
/// tamanho, outro título — e o defeito só apareceria no segundo uso da sessão,
/// que é o tipo de bug que ninguém reproduz.
const AVATAR_LAB_TITLE: &str = "AI-BOT — Laboratório de avatares";
const AVATAR_LAB_WIDTH: f64 = 980.0;
const AVATAR_LAB_HEIGHT: f64 = 680.0;
const AVATAR_LAB_MIN_WIDTH: f64 = 820.0;
const AVATAR_LAB_MIN_HEIGHT: f64 = 560.0;

/// Mostra e foca o laboratório de avatares, criando a janela se ela não existir.
///
/// # Por que este comando é `async`
///
/// Não é estilo: `WebviewWindowBuilder::build()` TRAVA quando chamado de um
/// comando síncrono no Windows. O comando síncrono roda na thread principal,
/// que é a mesma que atende o laço de mensagens que a criação da janela espera
/// — e as duas ficam se esperando. Como comando `async`, o corpo roda fora da
/// thread principal e a criação conclui. O sintoma de errar isso é o app
/// congelar por inteiro no clique, sem log e sem crash.
#[tauri::command]
pub async fn open_avatar_lab(app: AppHandle) -> Result<(), String> {
    let window = match app.get_webview_window(AVATAR_LAB_LABEL) {
        Some(existing) => existing,
        None => WebviewWindowBuilder::new(
            &app,
            AVATAR_LAB_LABEL,
            WebviewUrl::App(AVATAR_LAB_URL.into()),
        )
        .title(AVATAR_LAB_TITLE)
        .inner_size(AVATAR_LAB_WIDTH, AVATAR_LAB_HEIGHT)
        .min_inner_size(AVATAR_LAB_MIN_WIDTH, AVATAR_LAB_MIN_HEIGHT)
        // Nasce escondida e é o `show()` lá embaixo que a revela, pelo mesmo
        // motivo do tauri.conf.json: uma janela visível antes de o React montar
        // pisca branca na frente da pessoa.
        .visible(false)
        .build()
        .map_err(|error| {
            format!("não foi possível abrir o laboratório de avatares: {error}")
        })?,
    };

    // Melhor esforço, e ANTES do foco: no Windows, dar foco a uma janela
    // minimizada não a restaura — ela pisca na barra de tarefas e continua
    // minimizada. Para a pessoa, o clique no ícone simplesmente não funcionou.
    // Numa janela que não está minimizada isto não faz nada, então não há caso
    // em que valha interromper o comando por causa dele.
    let _ = window.unminimize();

    window
        .show()
        .map_err(|error| format!("não foi possível mostrar o laboratório de avatares: {error}"))?;
    window
        .set_focus()
        .map_err(|error| format!("não foi possível focar o laboratório de avatares: {error}"))?;

    Ok(())
}
