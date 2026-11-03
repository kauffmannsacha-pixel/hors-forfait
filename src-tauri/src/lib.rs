mod secrets;
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_sql::Builder::default().build())
        .invoke_handler(tauri::generate_handler![secrets::secret_get, secrets::secret_set, secrets::secret_del])
        .run(tauri::generate_context!())
        .expect("erreur au lancement de Prisme");
}
