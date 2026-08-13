use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AppInfo {
    pub name: String,
    pub version: String,
}

#[tauri::command]
pub fn get_app_info() -> Result<AppInfo, String> {
    Ok(AppInfo {
        name: env!("CARGO_PKG_NAME").to_owned(),
        version: env!("CARGO_PKG_VERSION").to_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::get_app_info;

    #[test]
    fn app_info_uses_package_metadata() {
        let info = get_app_info().expect("app info should be available");

        assert_eq!(info.name, "hammond-desktop");
        assert_eq!(info.version, "0.1.0");
    }
}
