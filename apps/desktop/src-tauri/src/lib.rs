mod auth;
mod extensions;
mod fsx;
mod memory;
mod providers;
mod research;
mod runtime;
mod sandbox;
mod terminal;

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

#[tauri::command]
fn credential_read(account: String) -> Result<String, String> {
    keyring::Entry::new("AI Orchestrator", &account)
        .map_err(|error| error.to_string())?
        .get_password()
        .map_err(|error| error.to_string())
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
        .invoke_handler(tauri::generate_handler![
            app_shutdown,
            credential_store,
            credential_read,
            credential_delete,
            auth::oidc_login,
            auth::oidc_restore,
            auth::oidc_logout,
            extensions::extension_inspect,
            extensions::extension_import,
            extensions::extension_list,
            runtime::runtime_status,
            runtime::runtime_install,
            runtime::runtime_start,
            runtime::runtime_stop,
            runtime::runtime_chat,
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
            research::research_fetch,
            sandbox::sandbox_execute,
            providers::provider_chat,
            providers::provider_fetch
        ])
        .run(tauri::generate_context!())
        .expect("failed to run AI Orchestrator");
}
