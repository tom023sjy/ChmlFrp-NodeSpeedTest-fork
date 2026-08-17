use crate::models::{FrpcProcesses, SpeedTestConfig};
use crate::utils::{get_app_data_dir, resolve_frpc_path};
use log::{info, warn};
use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use tauri::State;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

/// 校验 INI 配置值，防止注入攻击。
/// 拒绝包含换行符、回车符、方括号、等号、null 字节的值，
/// 避免攻击者通过 tunnel_name/server_addr 等字段注入额外配置项。
fn validate_ini_value(value: &str, field_name: &str) -> Result<(), String> {
    if value.contains(['\n', '\r', '[', ']', '=', '\0']) {
        return Err(format!(
            "字段 {} 包含非法字符（换行/方括号/等号/null），可能存在配置注入风险",
            field_name
        ));
    }
    Ok(())
}

/// 生成 frpc 配置文件，所有字段先校验再拼接
fn generate_config_file(
    config: &SpeedTestConfig,
    app_handle: &tauri::AppHandle,
) -> Result<std::path::PathBuf, String> {
    // 校验所有用户可控字段
    validate_ini_value(&config.server_addr, "server_addr")?;
    validate_ini_value(&config.user, "user")?;
    validate_ini_value(&config.token, "token")?;
    validate_ini_value(&config.tunnel_name, "tunnel_name")?;
    validate_ini_value(&config.local_ip, "local_ip")?;

    let data_dir = get_app_data_dir(app_handle)?;
    let config_path = data_dir.join("speedtest_frpc.ini");

    let config_content = format!(
        "[common]\nserver_addr = {}\nserver_port = {}\nuser = {}\ntoken = {}\nlog_level = info\ntls_enable = false\ntcp_mux = true\npool_count = 5\n\n[{}]\ntype = tcp\nlocal_ip = {}\nlocal_port = {}\nremote_port = {}\n",
        config.server_addr,
        config.server_port,
        config.user,
        config.token,
        config.tunnel_name,
        config.local_ip,
        config.local_port,
        config.remote_port
    );

    let mut file =
        std::fs::File::create(&config_path).map_err(|e| format!("创建配置文件失败: {}", e))?;
    file.write_all(config_content.as_bytes())
        .map_err(|e| format!("写入配置文件失败: {}", e))?;

    // 设置文件权限为 0600（仅所有者可读写），防止其他用户读取 frpc Token
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&config_path, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("设置文件权限失败: {}", e))?;
    }

    Ok(config_path)
}

#[tauri::command]
pub async fn start_frpc(
    app_handle: tauri::AppHandle,
    config: SpeedTestConfig,
    processes: State<'_, FrpcProcesses>,
) -> Result<(), String> {
    let tunnel_name = config.tunnel_name.clone();
    info!("[Frpc] Starting frpc for tunnel: {}", tunnel_name);

    {
        let procs = processes
            .processes
            .lock()
            .map_err(|e| format!("获取进程锁失败: {}", e))?;
        if procs.contains_key(&tunnel_name) {
            return Err("frpc 已在运行中".to_string());
        }
    }

    let frpc_path = resolve_frpc_path(&app_handle)?;
    if !frpc_path.exists() {
        return Err("frpc 未找到，请先下载".to_string());
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let metadata = std::fs::metadata(&frpc_path).map_err(|e| e.to_string())?;
        let mut perms = metadata.permissions();
        if perms.mode() & 0o111 == 0 {
            perms.set_mode(0o755);
            std::fs::set_permissions(&frpc_path, perms).map_err(|e| e.to_string())?;
        }
    }

    let config_path = generate_config_file(&config, &app_handle)?;

    let mut cmd = Command::new(&frpc_path);
    cmd.arg("-c")
        .arg(&config_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(0x08000000);
    }

    let mut child = cmd.spawn().map_err(|e| format!("启动 frpc 失败: {}", e))?;
    let pid = child.id();
    info!("[Frpc] frpc process spawned with PID: {:?}", pid);

    if let Some(stdout) = child.stdout.take() {
        let reader = BufReader::new(stdout);
        std::thread::spawn(move || {
            for line in reader.lines().flatten() {
                info!("[frpc stdout] {}", line);
            }
        });
    }

    if let Some(stderr) = child.stderr.take() {
        let reader = BufReader::new(stderr);
        std::thread::spawn(move || {
            for line in reader.lines().flatten() {
                warn!("[frpc stderr] {}", line);
            }
        });
    }

    {
        let mut procs = processes
            .processes
            .lock()
            .map_err(|e| format!("获取进程锁失败: {}", e))?;
        procs.insert(tunnel_name.clone(), child);
    }

    tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;
    Ok(())
}

#[tauri::command]
pub async fn stop_frpc(
    tunnel_name: String,
    processes: State<'_, FrpcProcesses>,
) -> Result<(), String> {
    let mut procs = processes
        .processes
        .lock()
        .map_err(|e| format!("获取进程锁失败: {}", e))?;
    if let Some(mut child) = procs.remove(&tunnel_name) {
        let _ = child.kill();
        let _ = child.wait();
    }
    Ok(())
}

#[tauri::command]
pub async fn stop_all_frpc(processes: State<'_, FrpcProcesses>) -> Result<(), String> {
    let mut procs = processes
        .processes
        .lock()
        .map_err(|e| format!("获取进程锁失败: {}", e))?;
    for (_, mut child) in procs.drain() {
        let _ = child.kill();
        let _ = child.wait();
    }
    Ok(())
}

#[tauri::command]
pub fn is_frpc_running(tunnel_name: String, processes: State<'_, FrpcProcesses>) -> bool {
    if let Ok(procs) = processes.processes.lock() {
        procs.contains_key(&tunnel_name)
    } else {
        false
    }
}

#[tauri::command]
pub async fn check_frpc_exists(app_handle: tauri::AppHandle) -> Result<bool, String> {
    let frpc_path = resolve_frpc_path(&app_handle)?;
    Ok(frpc_path.exists())
}
