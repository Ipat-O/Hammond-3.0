mod commands;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![commands::get_app_info])
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
