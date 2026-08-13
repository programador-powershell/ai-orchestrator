mod auth;
mod blocklist;
mod extensions;
mod fsx;
mod memory;
mod jail;
mod office;
mod office_edit;
mod pdf;
mod policy;
mod providers;
mod research;
mod runtime;
mod sandbox;
mod ssh;
mod terminal;
mod webhook;
mod workspace;

use runtime::RuntimeManager;
use tauri::{AppHandle, Manager, State};
use tokio::time::{timeout, Duration};

#[tauri::command]
fn credential_store(account: String, token: String) -> Result<(), String> {
    keyring::Entry::new("AI Orchestrator", &account)
        .map_err(|error| error.to_string())?
        .set_password(&token)
        .map_err(|error| error.to_string())
}

/// Existência da credencial SEM devolver o segredo. A UI só precisa saber se a
/// chave está configurada; ler o valor levaria o segredo para o heap do webview.
#[tauri::command]
fn credential_exists(account: String) -> Result<bool, String> {
    let entry =
        keyring::Entry::new("AI Orchestrator", &account).map_err(|error| error.to_string())?;
    Ok(entry.get_password().is_ok())
}

#[tauri::command]
fn credential_delete(account: String) -> Result<(), String> {
    keyring::Entry::new("AI Orchestrator", &account)
        .map_err(|error| error.to_string())?
        .delete_credential()
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn app_shutdown(app: AppHandle, runtime: State<'_, RuntimeManager>) -> Result<(), String> {
    // A local model must never keep the desktop process alive. Cleanup is bounded so
    // even a wedged runtime cannot make the close button hang indefinitely.
    let _ = timeout(Duration::from_secs(2), runtime::shutdown(&runtime)).await;
    app.exit(0);
    Ok(())
}

/// Comandos da edição FULL — inclui os caminhos diretos ao provedor (BYOK) e
/// o runtime local. Ver docs/adr-edicao-gerenciada.md.
#[cfg(not(feature = "managed"))]
fn handlers() -> impl Fn(tauri::ipc::Invoke) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        app_shutdown,
        credential_store,
        credential_exists,
        credential_delete,
        auth::oidc_login,
        auth::oidc_restore,
        auth::oidc_logout,
        policy::bootstrap_sync,
        policy::bootstrap_cached,
        extensions::extension_inspect,
        extensions::extension_import,
        extensions::extension_list,
        runtime::runtime_status,
        runtime::runtime_install,
        runtime::runtime_start,
        runtime::runtime_stop,
        runtime::runtime_chat,
        runtime::runtime_chat_stream,
        runtime::runtime_list_models,
        runtime::runtime_download_model,
        runtime::runtime_remove_model,
        terminal::terminal_catalog,
        terminal::terminal_execute,
        terminal::terminal_runtime_install,
        memory::memory_add,
        memory::memory_update,
        memory::memory_delete,
        memory::memory_list,
        memory::memory_touch,
        fsx::fs_list,
        fsx::fs_read,
        fsx::fs_write,
        office::office_extract,
        office_edit::office_replace_text,
        research::research_fetch,
        research::page_fetch,
        sandbox::sandbox_execute,
        workspace::sandbox_open,
        workspace::sandbox_close,
        workspace::sandbox_write,
        workspace::sandbox_read,
        workspace::sandbox_list,
        webhook::webhook_post,
        ssh::ssh_exec,
        ssh::ssh_fingerprint,
        providers::provider_chat,
        providers::provider_chat_stream,
        providers::provider_chat_cancel,
        providers::provider_fetch
    ]
}

/// Comandos da edição MANAGED: as quatro portas de saída direta ao provedor
/// (provider_chat, provider_chat_stream, provider_chat_cancel, provider_fetch)
/// e o runtime local NÃO EXISTEM no binário — esconder botão não segura nada;
/// compilar fora, sim. Todo tráfego de modelo passa pelo gateway, que aplica a
/// política e registra usage_events.
#[cfg(feature = "managed")]
fn handlers() -> impl Fn(tauri::ipc::Invoke) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        app_shutdown,
        credential_store,
        credential_exists,
        credential_delete,
        auth::oidc_login,
        auth::oidc_restore,
        auth::oidc_logout,
        policy::bootstrap_sync,
        policy::bootstrap_cached,
        extensions::extension_inspect,
        extensions::extension_import,
        extensions::extension_list,
        terminal::terminal_catalog,
        terminal::terminal_execute,
        terminal::terminal_runtime_install,
        memory::memory_add,
        memory::memory_update,
        memory::memory_delete,
        memory::memory_list,
        memory::memory_touch,
        fsx::fs_list,
        fsx::fs_read,
        fsx::fs_write,
        office::office_extract,
        office_edit::office_replace_text,
        research::research_fetch,
        research::page_fetch,
        sandbox::sandbox_execute,
        workspace::sandbox_open,
        workspace::sandbox_close,
        workspace::sandbox_write,
        workspace::sandbox_read,
        workspace::sandbox_list,
        webhook::webhook_post,
        ssh::ssh_exec,
        ssh::ssh_fingerprint
    ]
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(RuntimeManager::default())
        // Edição FULL: tudo registrado, inclusive as portas de saída direta
        // ao provedor (BYOK). A lista managed abaixo é a MESMA sem elas —
        // manter as duas em sincronia é intencional e explícito: um comando
        // novo obriga a decidir em qual edição ele existe.
        .invoke_handler(handlers())
        .run(tauri::generate_context!())
        .expect("failed to run AI Orchestrator");
}
