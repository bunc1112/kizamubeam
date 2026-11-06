pub mod agent;
mod fluid;
mod fonts;
mod library;
mod machine;
mod native;
mod netcam;
mod packs;
mod ruida;
mod serial_transport;
mod stream;
mod sync;
mod templates;
mod updater;
mod ws;

use tauri_plugin_dialog::DialogExt;

/// Speichert Text über einen nativen Speichern-Dialog. Gibt den Pfad zurück oder None bei Abbruch.
#[tauri::command]
async fn save_text_file(
    app: tauri::AppHandle,
    default_name: String,
    filter_name: String,
    extensions: Vec<String>,
    contents: String,
) -> Result<Option<String>, String> {
    let exts: Vec<&str> = extensions.iter().map(|s| s.as_str()).collect();
    let picked = app
        .dialog()
        .file()
        .set_file_name(&default_name)
        .add_filter(&filter_name, &exts)
        .blocking_save_file();
    let Some(path) = picked else { return Ok(None) };
    let path = path.into_path().map_err(|e| e.to_string())?;
    std::fs::write(&path, contents).map_err(|e| e.to_string())?;
    Ok(Some(path.display().to_string()))
}

/// Öffnet eine Textdatei über einen nativen Öffnen-Dialog.
#[tauri::command]
async fn open_text_file(
    app: tauri::AppHandle,
    filter_name: String,
    extensions: Vec<String>,
) -> Result<Option<(String, String)>, String> {
    let exts: Vec<&str> = extensions.iter().map(|s| s.as_str()).collect();
    let picked = app
        .dialog()
        .file()
        .add_filter(&filter_name, &exts)
        .blocking_pick_file();
    let Some(path) = picked else { return Ok(None) };
    let path = path.into_path().map_err(|e| e.to_string())?;
    let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    Ok(Some((path.display().to_string(), text)))
}

/// Datei über einen nativen Öffnen-Dialog auswählen (mehrere Filter möglich). Gibt den Pfad zurück.
#[tauri::command]
async fn pick_file(app: tauri::AppHandle, filters: Vec<(String, Vec<String>)>) -> Option<String> {
    let mut dlg = app.dialog().file();
    for (name, exts) in &filters {
        let e: Vec<&str> = exts.iter().map(|s| s.as_str()).collect();
        dlg = dlg.add_filter(name, &e);
    }
    let path = dlg.blocking_pick_file()?;
    path.into_path().ok().map(|p| p.display().to_string())
}

/// Mehrere Dateien über einen nativen Öffnen-Dialog auswählen. Gibt die Pfade zurück (leer = abgebrochen).
#[tauri::command]
async fn pick_files(app: tauri::AppHandle, filters: Vec<(String, Vec<String>)>) -> Vec<String> {
    let mut dlg = app.dialog().file();
    for (name, exts) in &filters {
        let e: Vec<&str> = exts.iter().map(|s| s.as_str()).collect();
        dlg = dlg.add_filter(name, &e);
    }
    dlg.blocking_pick_files()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|p| p.into_path().ok().map(|p| p.display().to_string()))
        .collect()
}

/// Inhalt einer Datei als Bytes (für Bilder und Importe).
#[tauri::command]
async fn read_file(path: String) -> Result<tauri::ipc::Response, String> {
    std::fs::read(&path).map(tauri::ipc::Response::new).map_err(|e| e.to_string())
}

/// Speichert Binärdaten (Base64) über einen nativen Speichern-Dialog.
#[tauri::command]
async fn save_binary_file(
    app: tauri::AppHandle,
    default_name: String,
    filter_name: String,
    extensions: Vec<String>,
    base64: String,
) -> Result<Option<String>, String> {
    let data = decode_base64(&base64).ok_or("Ungültige Daten")?;
    let exts: Vec<&str> = extensions.iter().map(|s| s.as_str()).collect();
    let picked = app
        .dialog()
        .file()
        .set_file_name(&default_name)
        .add_filter(&filter_name, &exts)
        .blocking_save_file();
    let Some(path) = picked else { return Ok(None) };
    let path = path.into_path().map_err(|e| e.to_string())?;
    std::fs::write(&path, data).map_err(|e| e.to_string())?;
    Ok(Some(path.display().to_string()))
}

pub(crate) fn decode_base64(s: &str) -> Option<Vec<u8>> {
    let val = |c: u8| -> Option<u32> {
        Some(match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        } as u32)
    };
    let bytes: Vec<u8> = s.bytes().filter(|c| !c.is_ascii_whitespace() && *c != b'=').collect();
    let mut out = Vec::with_capacity(bytes.len() * 3 / 4);
    for chunk in bytes.chunks(4) {
        let mut acc = 0u32;
        for (i, &c) in chunk.iter().enumerate() {
            acc |= val(c)? << (18 - 6 * i);
        }
        let n = chunk.len();
        if n < 2 {
            return None;
        }
        out.push((acc >> 16) as u8);
        if n > 2 {
            out.push((acc >> 8) as u8);
        }
        if n > 3 {
            out.push(acc as u8);
        }
    }
    Some(out)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        // Kamera für das Kamerabild auf der Arbeitsfläche ohne zusätzliche Rückfrage der Webansicht freigeben;
        // die Freigabe des Betriebssystems (macOS: Datenschutz › Kamera) bleibt davon unberührt.
        .on_permission_request(|_, kind| match kind {
            tauri::webview::PermissionKind::Camera => tauri::webview::PermissionResponse::Allow,
            _ => tauri::webview::PermissionResponse::Default,
        })
        .manage(machine::Machine::default())
        .manage(agent::Agent::default())
        .manage(netcam::NetCams::default())
        .manage(updater::Pending::default())
        .manage(std::sync::Arc::new(native::Native::default()))
        .setup(|app| {
            use tauri::Manager;
            agent::start(app.handle(), &app.state::<agent::Agent>());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            netcam::netcam_open,
            netcam::netcam_frame,
            netcam::netcam_close,
            save_text_file,
            open_text_file,
            pick_file,
            pick_files,
            read_file,
            save_binary_file,
            fonts::list_fonts,
            fonts::font_data,
            fonts::font_installed,
            fonts::font_catalog,
            fonts::font_install_google,
            fonts::font_import,
            fonts::font_remove,
            fonts::font_open_folder,
            machine::machine_ports,
            machine::machine_connect,
            machine::machine_disconnect,
            machine::machine_send,
            machine::machine_realtime,
            machine::machine_job,
            machine::machine_job_prepared,
            native::image_register,
            native::image_process,
            native::image_scan,
            native::gcode_prepare,
            native::gcode_save,
            machine::machine_pause,
            machine::machine_resume,
            machine::machine_stop,
            ruida::ruida_read,
            ruida::ruida_write,
            ruida::ruida_action,
            ruida::ruida_save,
            fluid::fluid_upload,
            fluid::fluid_discover,
            agent::agent_info,
            agent::agent_configure,
            agent::agent_new_token,
            agent::agent_respond,
            agent::agent_write_file,
            agent::agent_machine_log,
            templates::template_list,
            templates::template_read,
            templates::template_write,
            templates::template_delete,
            templates::template_open_folder,
            packs::pack_list,
            packs::pack_write,
            packs::pack_delete,
            packs::pack_open_folder,
            library::library_list,
            library::library_read,
            library::library_write,
            library::library_delete,
            library::library_open_folder,
            sync::sync_pick_folder,
            sync::sync_machine_name,
            sync::sync_list,
            sync::sync_read,
            sync::sync_write,
            sync::sync_open_folder,
            sync::sync_dir_stat,
            sync::sync_dir_read,
            sync::sync_dir_write,
            sync::sync_dir_delete,
            updater::update_supported,
            updater::update_check,
            updater::update_install
        ])
        .run(tauri::generate_context!())
        .expect("Fehler beim Start der Anwendung");
}
