// 系统信息收集（用于设备互联注册）
// 使用标准库 + Tauri 环境 API，无需引入 sysinfo 等重型依赖
use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemInfo {
    /// 操作系统描述，如 "Windows 11" / "Ubuntu 22.04" / "macOS 14"
    pub os_info: String,
    /// 主机名
    pub hostname: String,
}

/// 获取本机系统信息（用于设备互联 WebSocket 注册）
#[tauri::command]
pub fn get_system_info(app_handle: tauri::AppHandle) -> SystemInfo {
    let os_info = detect_os_info(&app_handle);
    let hostname = detect_hostname();
    SystemInfo { os_info, hostname }
}

/// 检测操作系统版本描述
fn detect_os_info(app_handle: &tauri::AppHandle) -> String {
    // 优先使用 Tauri 的 os plugin 信息（编译期 target）
    let platform = std::env::consts::OS;

    // 尝试从环境变量获取更精确的版本
    match platform {
        "windows" => detect_windows_version().unwrap_or_else(|| "Windows".to_string()),
        "macos" => detect_macos_version().unwrap_or_else(|| "macOS".to_string()),
        "linux" => detect_linux_version().unwrap_or_else(|| "Linux".to_string()),
        _ => {
            // 兜底：用 Tauri 的 webview window 信息
            let _ = app_handle;
            platform.to_string()
        }
    }
}

#[cfg(target_os = "windows")]
fn detect_windows_version() -> Option<String> {
    // 读取 RUSTC 环境不可靠，改用 systeminfo 或注册表会太重
    // 使用 std::env 里的 OS 信息即可，前端展示足够
    let major = std::env::var("OS").unwrap_or_default();
    if major.contains("Windows") {
        Some("Windows".to_string())
    } else {
        Some("Windows".to_string())
    }
}

#[cfg(not(target_os = "windows"))]
fn detect_windows_version() -> Option<String> {
    None
}

#[cfg(target_os = "macos")]
fn detect_macos_version() -> Option<String> {
    use std::process::Command;
    let output = Command::new("sw_vers")
        .arg("-productVersion")
        .output()
        .ok()?;
    let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if version.is_empty() {
        None
    } else {
        Some(format!("macOS {}", version))
    }
}

#[cfg(not(target_os = "macos"))]
fn detect_macos_version() -> Option<String> {
    None
}

#[cfg(target_os = "linux")]
fn detect_linux_version() -> Option<String> {
    use std::process::Command;
    // 尝试 lsb_release
    if let Ok(output) = Command::new("lsb_release").arg("-ds").output() {
        let desc = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !desc.is_empty() {
            return Some(desc);
        }
    }
    // 尝试读 /etc/os-release
    if let Ok(content) = std::fs::read_to_string("/etc/os-release") {
        for line in content.lines() {
            if let Some(pretty) = line.strip_prefix("PRETTY_NAME=") {
                let v = pretty.trim_matches('"').to_string();
                if !v.is_empty() {
                    return Some(v);
                }
            }
        }
    }
    Some("Linux".to_string())
}

#[cfg(not(target_os = "linux"))]
fn detect_linux_version() -> Option<String> {
    None
}

/// 检测主机名
fn detect_hostname() -> String {
    // 优先使用环境变量 HOSTNAME（Linux 常见）
    if let Ok(h) = std::env::var("HOSTNAME") {
        if !h.is_empty() {
            return h;
        }
    }
    // 使用 Tauri 的 computer_name（Windows）
    #[cfg(target_os = "windows")]
    {
        if let Ok(h) = std::env::var("COMPUTERNAME") {
            if !h.is_empty() {
                return h;
            }
        }
    }
    // 调用 hostname 命令（Unix）
    #[cfg(unix)]
    {
        use std::process::Command;
        if let Ok(output) = Command::new("hostname").output() {
            let h = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !h.is_empty() {
                return h;
            }
        }
    }
    "unknown".to_string()
}
