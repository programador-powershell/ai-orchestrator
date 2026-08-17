mod auth;
mod blocklist;
mod extensions;
mod fsx;
mod instalacao;
mod mcp;
mod memory;
mod jail;
mod office;
mod office_edit;
mod pdf;
mod policy;
mod rebrand;
mod providers;
mod pty;
mod research;
mod runstore;
mod runtime;
mod sandbox;
mod sbx;
mod ssh;
mod terminal;
mod webhook;
mod workspace;

use runtime::RuntimeManager;
use tauri::{AppHandle, Manager, State};
use tokio::time::{timeout, Duration};

#[tauri::command]
fn credential_store(account: String, token: String) -> Result<(), String> {
    keyring::Entry::new("AI-Orchestrator", &account)
        .map_err(|error| error.to_string())?
        .set_password(&token)
        .map_err(|error| error.to_string())
}

/// Existência da credencial SEM devolver o segredo. A UI só precisa saber se a
/// chave está configurada; ler o valor levaria o segredo para o heap do webview.
#[tauri::command]
fn credential_exists(account: String) -> Result<bool, String> {
    // Passa pelo fallback do rebranding: chave gravada antes da 0.11.0 está
    // sob o serviço antigo, e responder "não configurada" mandaria a pessoa
    // recadastrar uma credencial que ela já tem. A primeira leitura também
    // converte a entrada para o nome novo.
    Ok(rebrand::segredo_com_fallback(&account).is_some())
}

#[tauri::command]
fn credential_delete(account: String) -> Result<(), String> {
    // Apaga também sob o nome antigo: senão "remover a chave" removeria só a
    // cópia nova e o fallback de leitura traria a velha de volta.
    if let Ok(antiga) = keyring::Entry::new(rebrand::SERVICO_ANTIGO, &account) {
        let _ = antiga.delete_credential();
    }
    keyring::Entry::new(rebrand::SERVICO, &account)
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
        // Log local do run — fonte de verdade do local-first (src/runstore.rs).
        // Vale nas DUAS edições: durabilidade não é porta de saída ao provedor,
        // é o registro do que a máquina fez. Na edição managed o run continua
        // sendo gravado aqui e sincronizado para o gateway auditar.
        runstore::run_session_create,
        runstore::run_sessions_list,
        runstore::run_create,
        runstore::run_append,
        runstore::run_events_since,
        runstore::run_get,
        runstore::run_list,
        runstore::run_set_status,
        runstore::run_mark_synced,
        runstore::run_pending_sync,
        runstore::run_approval_ask,
        runstore::run_approval_decide,
        runstore::run_approvals_pending,
        // Terminal interativo (src/pty.rs). `pty_write` é tecla de HUMANO —
        // nenhum destes entra no registro de ferramentas do agente, senão o
        // modelo escreveria num shell aberto e contornaria todo gate de
        // aprovação de uma vez. Ver o cabeçalho de pty.rs.
        pty::pty_spawn,
        pty::pty_write,
        pty::pty_resize,
        pty::pty_ack,
        pty::pty_kill,
        pty::pty_kill_all,
        pty::pty_list,
        fsx::fs_list,
        fsx::fs_read,
        fsx::fs_write,
        fsx::fs_remove,
        office::office_extract,
        office_edit::office_replace_text,
        research::research_fetch,
        research::page_fetch,
        sandbox::sandbox_execute,
        sbx::sbx_status,
        workspace::sandbox_open,
        workspace::sandbox_close,
        workspace::sandbox_write,
        workspace::sandbox_read,
        workspace::sandbox_list,
        webhook::webhook_post,
        mcp::mcp_rpc,
        ssh::ssh_exec,
        ssh::ssh_fingerprint,
        ssh::ssh_read,
        ssh::ssh_write,
        ssh::ssh_list,
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
        // Log local do run — fonte de verdade do local-first (src/runstore.rs).
        // Vale nas DUAS edições: durabilidade não é porta de saída ao provedor,
        // é o registro do que a máquina fez. Na edição managed o run continua
        // sendo gravado aqui e sincronizado para o gateway auditar.
        runstore::run_session_create,
        runstore::run_sessions_list,
        runstore::run_create,
        runstore::run_append,
        runstore::run_events_since,
        runstore::run_get,
        runstore::run_list,
        runstore::run_set_status,
        runstore::run_mark_synced,
        runstore::run_pending_sync,
        runstore::run_approval_ask,
        runstore::run_approval_decide,
        runstore::run_approvals_pending,
        // Terminal interativo (src/pty.rs). `pty_write` é tecla de HUMANO —
        // nenhum destes entra no registro de ferramentas do agente, senão o
        // modelo escreveria num shell aberto e contornaria todo gate de
        // aprovação de uma vez. Ver o cabeçalho de pty.rs.
        pty::pty_spawn,
        pty::pty_write,
        pty::pty_resize,
        pty::pty_ack,
        pty::pty_kill,
        pty::pty_kill_all,
        pty::pty_list,
        fsx::fs_list,
        fsx::fs_read,
        fsx::fs_write,
        fsx::fs_remove,
        office::office_extract,
        office_edit::office_replace_text,
        research::research_fetch,
        research::page_fetch,
        sandbox::sandbox_execute,
        sbx::sbx_status,
        workspace::sandbox_open,
        workspace::sandbox_close,
        workspace::sandbox_write,
        workspace::sandbox_read,
        workspace::sandbox_list,
        webhook::webhook_post,
        mcp::mcp_rpc,
        ssh::ssh_exec,
        ssh::ssh_fingerprint,
        ssh::ssh_read,
        ssh::ssh_write,
        ssh::ssh_list
    ]
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    /*
     * ANTES de qualquer coisa do Tauri.
     *
     * A pasta do WebView2 (%LOCALAPPDATA%<identifier>) nasce junto com a
     * janela; renomear depois encontraria o destino já criado e não migraria
     * nada — o usuário abriria a versão nova com o histórico zerado e os
     * dados antigos intactos numa pasta que ninguém mais lê.
     */
    for item in rebrand::migrar_diretorios() {
        eprintln!("[rebrand] migrado do nome anterior: {item}");
    }

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
        .manage(pty::PtyState::default())
        // Edição FULL: tudo registrado, inclusive as portas de saída direta
        // ao provedor (BYOK). A lista managed abaixo é a MESMA sem elas —
        // manter as duas em sincronia é intencional e explícito: um comando
        // novo obriga a decidir em qual edição ele existe.
        .invoke_handler(handlers())
        .run(tauri::generate_context!())
        .expect("failed to run AI-Orchestrator");
}
