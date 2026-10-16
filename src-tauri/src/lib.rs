mod commands;
mod encoder;
mod probe;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(commands::ExportCancel::default())
        .setup(|app| {
            // Shared URL download engine (yt-dlp + updates, scraper, sniff mode,
            // cookies). Desktop-only; local files never touch the network.
            smith_fetch::tauri_glue::init(app.handle(), "GifSmith", commands::download_dir())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::probe_video,
            commands::generate_filmstrip,
            commands::generate_proxy,
            smith_fetch::tauri_glue::download_video,
            smith_fetch::tauri_glue::fetch_download,
            smith_fetch::tauri_glue::fetch_probe,
            smith_fetch::tauri_glue::fetch_download_hit,
            smith_fetch::tauri_glue::cancel_download,
            smith_fetch::tauri_glue::stop_recording,
            smith_fetch::tauri_glue::browse_open,
            smith_fetch::tauri_glue::browse_close,
            smith_fetch::tauri_glue::browse_hits,
            smith_fetch::tauri_glue::browse_save_signin,
            smith_fetch::tauri_glue::sniff_report,
            smith_fetch::tauri_glue::cookies_list,
            smith_fetch::tauri_glue::cookies_forget,
            smith_fetch::tauri_glue::cookies_import,
            smith_fetch::tauri_glue::fetch_settings_get,
            smith_fetch::tauri_glue::fetch_settings_set,
            smith_fetch::tauri_glue::tools_status,
            smith_fetch::tauri_glue::tools_update_now,
            commands::export_preview,
            commands::cancel_export,
            commands::default_save_path,
            commands::save_preview,
            commands::discard_preview,
            commands::get_exports_dir,
            commands::list_exports,
            commands::gallery_thumbnail,
            commands::check_for_update
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
