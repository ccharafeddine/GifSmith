fn main() {
    // Declaring an app manifest puts every app command under Tauri's ACL, so
    // the full list lives here. The main window is granted all of them except
    // sniff_report in capabilities/default.json; remote pages in the in-app
    // Browse window get only sniff_report (capabilities/sniff.json).
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "probe_video",
            "generate_filmstrip",
            "generate_proxy",
            "download_video",
            "fetch_download",
            "fetch_probe",
            "fetch_download_hit",
            "cancel_download",
            "stop_recording",
            "browse_open",
            "browse_close",
            "browse_hits",
            "browse_save_signin",
            "sniff_report",
            "cookies_list",
            "cookies_forget",
            "cookies_import",
            "fetch_settings_get",
            "fetch_settings_set",
            "tools_status",
            "tools_update_now",
            "export_preview",
            "cancel_export",
            "default_save_path",
            "save_preview",
            "discard_preview",
            "get_exports_dir",
            "list_exports",
            "gallery_thumbnail",
            "check_for_update",
        ]),
    ))
    .expect("failed to run tauri-build");
}
