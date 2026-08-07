// 窗口与系统托盘相关命令
use tauri::Manager;

/// 最小化到系统托盘（隐藏主窗口，应用继续运行）
#[tauri::command]
pub fn minimize_to_tray(app_handle: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app_handle.get_webview_window("main") {
        window.hide().map_err(|e| format!("隐藏窗口失败: {}", e))?;
    }
    Ok(())
}

/// 退出应用（会触发 ExitRequested 事件以处理待安装更新）
#[tauri::command]
pub fn exit_app(app_handle: tauri::AppHandle) {
    app_handle.exit(0);
}

/// 打开系统自定义协议 URL（如 windowsdefender://）
///
/// tauri-plugin-opener 默认仅允许 http/https/mailto，
/// 对于 windowsdefender:// 这类系统协议需通过系统命令直接调用。
///
/// - Windows: 使用 PowerShell Start-Process 启动（兼容自定义协议处理器）
/// - macOS: 使用 /usr/bin/open
/// - Linux: 使用 xdg-open
#[tauri::command]
pub fn open_system_url(url: String) -> Result<(), String> {
    if url.is_empty() {
        return Err("URL 不能为空".to_string());
    }
    // 简单校验，避免命令注入：仅允许字母数字+:/.-_
    if !url
        .chars()
        .all(|c| c.is_alphanumeric() || matches!(c, ':' | '/' | '.' | '-' | '_'))
    {
        return Err(format!("URL 包含非法字符: {}", url));
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        use std::process::Command;
        // 用 cmd /c start 打开自定义协议，避免 PowerShell 窗口闪现
        Command::new("cmd")
            .args(["/C", "start", "", &url])
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .spawn()
            .map_err(|e| format!("打开失败: {}", e))?;
    }

    #[cfg(target_os = "macos")]
    {
        use std::process::Command;
        Command::new("/usr/bin/open")
            .arg(&url)
            .spawn()
            .map_err(|e| format!("打开失败: {}", e))?;
    }

    #[cfg(target_os = "linux")]
    {
        use std::process::Command;
        Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(|e| format!("打开失败: {}", e))?;
    }

    Ok(())
}
