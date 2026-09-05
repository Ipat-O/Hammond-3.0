mod commands;
mod fs_commands;
mod fs_guard;
mod harness;
mod harness_commands;
mod local_settings;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(local_settings::LocalSettingsState::default())
        .invoke_handler(tauri::generate_handler![
            commands::get_app_info,
            fs_commands::select_directory,
            fs_commands::read_text_file,
            fs_commands::write_text_file,
            fs_commands::remove_path,
            fs_commands::path_exists,
            fs_commands::reveal_path,
            local_settings::local_settings_read,
            local_settings::local_settings_write,
            local_settings::local_settings_remove,
            harness_commands::harness_target_path,
            harness_commands::harness_classify,
            harness_commands::harness_inject,
            harness_commands::harness_remove,
            harness_commands::harness_render_preview,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Hammond");
}

#[cfg(test)]
mod tests {
    use super::commands::AppInfo;

    #[test]
    fn app_info_contract_is_serializable_and_stable() {
        let info = AppInfo {
            name: "hammond-desktop".to_owned(),
            version: "0.1.0".to_owned(),
        };

        assert_eq!(info.name, "hammond-desktop");
        assert_eq!(info.version, "0.1.0");
        assert_eq!(
            serde_json::to_string(&info).unwrap(),
            r#"{"name":"hammond-desktop","version":"0.1.0"}"#
        );
    }
}
