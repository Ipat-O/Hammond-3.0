mod agent_access;
mod commands;
mod fs_commands;
mod fs_guard;
mod harness;
mod harness_commands;
mod local_settings;
#[cfg(test)]
mod window_close_permission_tests;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(local_settings::LocalSettingsState::default())
        .setup(|app| {
            let handle = app.handle().clone();
            // Binds the local-API listener and installs `AgentAccessState` before the event loop
            // starts, so the local API and its credentials file exist the moment Hammond is
            // running — never gated behind the owner navigating to a particular screen. This
            // blocks startup only long enough for a TCP bind and a small file read/write. On
            // failure `bootstrap` still installs a safe disabled `AgentAccessState`, so the
            // Settings panel's `agent_access_*` commands never hit unmanaged state.
            if let Err(error) =
                tauri::async_runtime::block_on(agent_access::server::bootstrap(handle))
            {
                eprintln!("failed to start local agent-access API (running disabled): {error}");
            }
            Ok(())
        })
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
            agent_access::commands::agent_access_respond,
            agent_access::commands::agent_access_disconnect,
            agent_access::commands::agent_access_set_listener_attached,
            agent_access::commands::agent_access_set_signed_in,
            agent_access::commands::agent_access_get_status,
            agent_access::commands::agent_access_reveal_token,
            agent_access::commands::agent_access_rotate_token,
            agent_access::commands::agent_access_revoke_token,
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
