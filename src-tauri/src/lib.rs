mod commands;
mod encoder;
mod probe;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::probe_video,
            commands::generate_filmstrip,
            commands::download_video,
            commands::export_preview,
            commands::save_preview,
            commands::discard_preview
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| {
            // Delete the preview GIF and any URL download when the app exits.
            if let tauri::RunEvent::Exit = event {
                commands::cleanup_temp();
            }
        });
}
