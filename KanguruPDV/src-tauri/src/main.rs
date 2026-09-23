#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use keyring::Entry;

const KEYRING_SERVICE: &str = "com.kanguruerp.pdv";
const KEYRING_ACCOUNT: &str = "supabase-device-session";

fn session_entry() -> Result<Entry, String> {
    Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT).map_err(|error| error.to_string())
}

#[tauri::command]
fn save_device_session(session: String) -> Result<(), String> {
    session_entry()?
        .set_password(&session)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn load_device_session() -> Result<Option<String>, String> {
    match session_entry()?.get_password() {
        Ok(session) => Ok(Some(session)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
fn clear_device_session() -> Result<(), String> {
    match session_entry()?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            save_device_session,
            load_device_session,
            clear_device_session
        ])
        .run(tauri::generate_context!())
        .expect("error while running Kanguru PDV");
}