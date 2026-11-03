// Coffre Windows Credential Manager via keyring.
fn entry(key: &str) -> Result<keyring::Entry, String> { keyring::Entry::new("Prisme", key).map_err(|e| e.to_string()) }
#[tauri::command] pub fn secret_get(key: String) -> Result<Option<String>, String> {
    match entry(&key)?.get_password() { Ok(v) => Ok(Some(v)), Err(keyring::Error::NoEntry) => Ok(None), Err(e) => Err(e.to_string()) }
}
#[tauri::command] pub fn secret_set(key: String, value: String) -> Result<(), String> { entry(&key)?.set_password(&value).map_err(|e| e.to_string()) }
#[tauri::command] pub fn secret_del(key: String) -> Result<(), String> { let _ = entry(&key)?.delete_credential(); Ok(()) }
