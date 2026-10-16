fn main() {
    // `sniff_report` is the one command remote pages in the in-app Browse
    // window may call (see capabilities/sniff.json); declaring it here makes
    // Tauri generate its permission. Every other command stays local-only.
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&["sniff_report"])),
    )
    .expect("failed to run tauri-build");
}
