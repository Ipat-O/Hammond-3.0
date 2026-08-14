//! Device-local key/value settings storage, backed by a single JSON file in the app's
//! local data directory. This is intentionally separate from the confined project-root
//! filesystem commands in [`crate::fs_commands`]: settings live in Hammond's own storage,
//! never inside an owner-selected project directory.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager, State};

const SETTINGS_FILE_NAME: &str = "local-settings.json";

pub struct LocalSettingsState(pub Mutex<()>);

impl Default for LocalSettingsState {
    fn default() -> Self {
        LocalSettingsState(Mutex::new(()))
    }
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", content = "message")]
pub enum LocalSettingsError {
    Unavailable(String),
    Io(String),
}

fn settings_file_path(app: &AppHandle) -> Result<PathBuf, LocalSettingsError> {
    let dir = app.path().app_local_data_dir().map_err(|error| {
        LocalSettingsError::Unavailable(format!("no local data directory: {error}"))
    })?;
    fs::create_dir_all(&dir).map_err(|error| {
        LocalSettingsError::Io(format!("failed to prepare settings directory: {error}"))
    })?;
    Ok(dir.join(SETTINGS_FILE_NAME))
}

fn read_all(path: &Path) -> Result<HashMap<String, Value>, LocalSettingsError> {
    match fs::read_to_string(path) {
        Ok(contents) => {
            if contents.trim().is_empty() {
                return Ok(HashMap::new());
            }
            serde_json::from_str(&contents).map_err(|error| {
                LocalSettingsError::Io(format!("settings file is corrupt: {error}"))
            })
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(HashMap::new()),
        Err(error) => Err(LocalSettingsError::Io(format!(
            "failed to read settings file: {error}"
        ))),
    }
}

fn write_all(path: &Path, values: &HashMap<String, Value>) -> Result<(), LocalSettingsError> {
    let serialized = serde_json::to_string_pretty(values).map_err(|error| {
        LocalSettingsError::Io(format!("failed to serialize settings: {error}"))
    })?;
    fs::write(path, serialized)
        .map_err(|error| LocalSettingsError::Io(format!("failed to write settings file: {error}")))
}

#[tauri::command]
pub fn local_settings_read(
    app: AppHandle,
    state: State<'_, LocalSettingsState>,
    key: String,
) -> Result<Option<Value>, LocalSettingsError> {
    let _guard = state.0.lock().expect("local settings lock poisoned");
    let path = settings_file_path(&app)?;
    let values = read_all(&path)?;
    Ok(values.get(&key).cloned())
}

#[tauri::command]
pub fn local_settings_write(
    app: AppHandle,
    state: State<'_, LocalSettingsState>,
    key: String,
    value: Value,
) -> Result<(), LocalSettingsError> {
    let _guard = state.0.lock().expect("local settings lock poisoned");
    let path = settings_file_path(&app)?;
    let mut values = read_all(&path)?;
    values.insert(key, value);
    write_all(&path, &values)
}

#[tauri::command]
pub fn local_settings_remove(
    app: AppHandle,
    state: State<'_, LocalSettingsState>,
    key: String,
) -> Result<(), LocalSettingsError> {
    let _guard = state.0.lock().expect("local settings lock poisoned");
    let path = settings_file_path(&app)?;
    let mut values = read_all(&path)?;
    values.remove(&key);
    write_all(&path, &values)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn round_trips_a_value_through_read_write_remove() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(SETTINGS_FILE_NAME);

        assert_eq!(read_all(&path).unwrap().get("directoryContexts"), None);

        let mut values = read_all(&path).unwrap();
        values.insert("directoryContexts".to_owned(), json!({"version": 1}));
        write_all(&path, &values).unwrap();

        let reloaded = read_all(&path).unwrap();
        assert_eq!(
            reloaded.get("directoryContexts"),
            Some(&json!({"version": 1}))
        );

        let mut values = reloaded;
        values.remove("directoryContexts");
        write_all(&path, &values).unwrap();
        assert_eq!(read_all(&path).unwrap().get("directoryContexts"), None);
    }

    #[test]
    fn missing_settings_file_reads_as_empty_rather_than_erroring() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("does-not-exist.json");
        assert_eq!(read_all(&path).unwrap(), HashMap::new());
    }

    #[test]
    fn corrupt_settings_file_surfaces_a_structured_io_error() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(SETTINGS_FILE_NAME);
        fs::write(&path, "not json").unwrap();
        let error = read_all(&path).unwrap_err();
        assert!(matches!(error, LocalSettingsError::Io(_)));
    }
}
