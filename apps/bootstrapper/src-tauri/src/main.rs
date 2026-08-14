#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod installer;

fn main() {
    tauri::Builder::default()
        .manage(installer::InstallState::default())
        .invoke_handler(tauri::generate_handler![
            installer::begin_install,
            installer::pause_install,
            installer::resume_install,
            installer::cancel_install,
            installer::retry_install,
            installer::close_installer
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Multiplike-AI installer");
}
