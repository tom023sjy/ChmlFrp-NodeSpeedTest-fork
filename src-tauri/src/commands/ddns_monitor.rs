// DDNS 动态解析监控调度器
// 基础 tick 10s，遍历所有启用的任务：
//   - Scheduled 模式：检查当前 HH:mm 是否匹配任务配置的任一时间点（且本次分钟内未触发过）
//   - Intervals 模式：根据当前时间所在时间段，判定距上次检查是否已达 interval_secs
// 检测本机网卡 IP，若与 last_ip 不同则调用 ChmlFrp API 更新记录
// access_token 从 UserTokenState 获取（登录后前端推送）
use chrono::{Local, NaiveTime};
use local_ip_address::list_afinet_netifas;
use tauri::{Emitter, Manager};

use super::dns_config::{self, UserTokenState};
use super::dns_provider::{self, DnsCredential, DnsProviderKind};
use super::ddns_task::{
    self, append_log, format_local_time, parse_local_time, CredentialSource, DdnsLog, DdnsTask, ScheduleMode,
};

/// 调度器基础 tick（秒）
const SCHEDULER_TICK_SECS: u64 = 10;
/// 触发时间点匹配容差（秒）：时间点 HH:mm 在 [now, now+TICK) 内视为触发
const SCHEDULE_MATCH_WINDOW_SECS: i64 = 30;

/// 应用启动时调用：常驻调度任务
pub fn start_monitor(app_handle: tauri::AppHandle) {
    let handle = app_handle.clone();
    tauri::async_runtime::spawn(async move {
        log::info!("[DDNS] 动态解析调度器启动，基础 tick {}s", SCHEDULER_TICK_SECS);
        let mut interval = tokio::time::interval(tokio::time::Duration::from_secs(SCHEDULER_TICK_SECS));
        interval.tick().await; // 跳过首次立即触发
        loop {
            interval.tick().await;
            if let Err(e) = run_once(&handle).await {
                log::warn!("[DDNS] 本轮检查失败: {}", e);
            }
        }
    });
}

/// 单轮检查
async fn run_once(app_handle: &tauri::AppHandle) -> Result<(), String> {
    let mut tasks = ddns_task::read_all_tasks(app_handle)?;
    let now = Local::now();
    let mut changed = false;

    for task in tasks.iter_mut() {
        if !task.enabled {
            continue;
        }
        if !should_check(task, &now) {
            continue;
        }
        match check_and_update(app_handle, task).await {
            Ok(_) => {}
            Err(e) => {
                task.last_check = Some(format_local_time(now));
                task.last_message = Some(format!("错误: {}", e));
                append_log(app_handle, DdnsLog {
                    time: String::new(),
                    task_id: task.id.clone(),
                    task_name: task.name.clone(),
                    action: "error".to_string(),
                    detected_ip: None,
                    previous_ip: task.last_ip.clone(),
                    updated_ip: None,
                    message: e.clone(),
                    owner_username: task.owner_username.clone(),
                });
                log::warn!("[DDNS] 任务 {} 检查失败: {}", task.name, e);
            }
        }
        changed = true;
    }

    if changed {
        ddns_task::write_all_tasks(app_handle, &tasks)?;
        let _ = app_handle.emit("ddns-task-event", serde_json::json!({ "refresh": true }));
    }
    Ok(())
}

/// 判断任务是否应该在本轮检查
fn should_check(task: &DdnsTask, now: &chrono::DateTime<Local>) -> bool {
    match &task.schedule {
        ScheduleMode::Scheduled { times } => {
            let now_hm = now.format("%H:%M").to_string();
            if !times.iter().any(|t| t == &now_hm) {
                return false;
            }
            // 同一分钟内只触发一次：若 last_check 也在本分钟内则跳过
            if let Some(last) = task.last_check.as_ref().and_then(|s| parse_local_time(s)) {
                if (*now - last).num_seconds().abs() < SCHEDULE_MATCH_WINDOW_SECS {
                    return false;
                }
            }
            true
        }
        ScheduleMode::Intervals { intervals, fallback_interval_secs } => {
            let interval_secs = match find_current_interval(intervals, now) {
                Some(ti) => ti.interval_secs,
                None => *fallback_interval_secs,
            };
            if interval_secs == 0 {
                return false;
            }
            match task.last_check.as_ref().and_then(|s| parse_local_time(s)) {
                Some(last) => (*now - last).num_seconds() >= interval_secs as i64,
                None => true, // 从未检查过，立即触发
            }
        }
    }
}

/// 在时间段列表中查找当前时间所在的时间段
fn find_current_interval<'a>(intervals: &'a [super::ddns_task::TimeInterval], now: &chrono::DateTime<Local>) -> Option<&'a super::ddns_task::TimeInterval> {
    let now_time = now.time();
    for ti in intervals {
        if let (Ok(start), Ok(end)) = (parse_hm(&ti.start), parse_hm(&ti.end)) {
            // 支持跨天：end < start 视为跨天段
            let in_range = if start <= end {
                now_time >= start && now_time <= end
            } else {
                now_time >= start || now_time <= end
            };
            if in_range {
                return Some(ti);
            }
        }
    }
    None
}

fn parse_hm(s: &str) -> Result<NaiveTime, String> {
    NaiveTime::parse_from_str(s, "%H:%M").map_err(|e| format!("时间格式错误 {}: {}", s, e))
}

/// 获取本机指定网卡的 IP（按记录类型选择 IPv4 或 IPv6）
fn get_interface_ip(interface: &str, record_type: &str) -> Result<String, String> {
    let want_v6 = record_type.eq_ignore_ascii_case("AAAA");
    let ifaces = list_afinet_netifas().map_err(|e| format!("获取网卡列表失败: {}", e))?;

    if interface.is_empty() {
        // 自动选择：优先返回非回环、非链路本地的 IP
        for (name, ip) in ifaces.iter() {
            if ip.is_loopback() {
                continue;
            }
            if want_v6 {
                if ip.is_ipv6() && !is_link_local_ipv6(ip) {
                    log::info!("[DDNS] 自动选择网卡 {} -> {}", name, ip);
                    return Ok(ip.to_string());
                }
            } else if ip.is_ipv4() {
                log::info!("[DDNS] 自动选择网卡 {} -> {}", name, ip);
                return Ok(ip.to_string());
            }
        }
        return Err(format!("未找到非回环的 {} 网卡", if want_v6 { "IPv6" } else { "IPv4" }));
    }

    for (name, ip) in ifaces.iter() {
        if name != interface || ip.is_loopback() {
            continue;
        }
        if want_v6 && ip.is_ipv6() && !is_link_local_ipv6(ip) {
            return Ok(ip.to_string());
        }
        if !want_v6 && ip.is_ipv4() {
            return Ok(ip.to_string());
        }
    }
    Err(format!("网卡 {} 上未找到可用 {} 地址", interface, if want_v6 { "IPv6" } else { "IPv4" }))
}

/// 判断 IPv6 是否为链路本地地址（fe80::/10）
fn is_link_local_ipv6(ip: &std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V6(v6) => {
            let seg = v6.segments()[0];
            (seg & 0xffc0) == 0xfe80
        }
        _ => false,
    }
}

/// 列出所有本机网卡（供前端选择，同时返回 IPv4 和 IPv6）
#[tauri::command]
pub async fn ddns_list_interfaces() -> Result<Vec<NetworkInterfaceInfo>, String> {
    let ifaces = list_afinet_netifas().map_err(|e| format!("获取网卡列表失败: {}", e))?;
    let mut result: Vec<NetworkInterfaceInfo> = ifaces
        .into_iter()
        .filter(|(_, ip)| !ip.is_loopback() && !(ip.is_ipv6() && is_link_local_ipv6(ip)))
        .map(|(name, ip)| NetworkInterfaceInfo {
            name,
            ip: ip.to_string(),
            is_ipv6: ip.is_ipv6(),
        })
        .collect();
    result.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(result)
}

/// 网卡信息（前端展示用）
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkInterfaceInfo {
    pub name: String,
    pub ip: String,
    pub is_ipv6: bool,
}

/// 执行单次检查并按需更新
async fn check_and_update(app_handle: &tauri::AppHandle, task: &mut DdnsTask) -> Result<(), String> {
    let now = Local::now();
    let detected_ip = get_interface_ip(&task.interface, &task.record_type)?;
    let previous_ip = task.last_ip.clone();

    task.last_check = Some(format_local_time(now));
    task.last_ip = Some(detected_ip.clone());

    // 若 IP 未变化，无需更新
    if let Some(prev) = previous_ip.as_ref() {
        if prev == &detected_ip {
            task.last_message = Some(format!("IP 未变化: {}", detected_ip));
            append_log(app_handle, DdnsLog {
                time: String::new(),
                task_id: task.id.clone(),
                task_name: task.name.clone(),
                action: "check".to_string(),
                detected_ip: Some(detected_ip.clone()),
                previous_ip: previous_ip.clone(),
                updated_ip: None,
                message: "IP 未变化".to_string(),
                owner_username: task.owner_username.clone(),
            });
            return Ok(());
        }
    }

    // IP 变化，根据凭证来源调用对应 DNS API 更新记录
    let cred = match &task.credential_source {
        CredentialSource::Chmlfrp => {
            let access_token = get_access_token(app_handle)?;
            build_chmlfrp_credential(&access_token)?
        }
        CredentialSource::Credential { credential_id } => {
            find_dns_credential(app_handle, &task.owner_username, credential_id)?
        }
    };

    dns_provider::upsert_record(&cred, &task.domain, &task.record, &task.record_type, &detected_ip).await?;

    task.last_updated_ip = Some(detected_ip.clone());
    task.last_message = Some(format!("IP 更新成功: {} -> {}", previous_ip.as_deref().unwrap_or("无"), detected_ip));

    append_log(app_handle, DdnsLog {
        time: String::new(),
        task_id: task.id.clone(),
        task_name: task.name.clone(),
        action: "update".to_string(),
        detected_ip: Some(detected_ip.clone()),
        previous_ip: previous_ip.clone(),
        updated_ip: Some(detected_ip.clone()),
        message: format!("{} -> {}", previous_ip.as_deref().unwrap_or("无"), detected_ip),
        owner_username: task.owner_username.clone(),
    });

    log::info!("[DDNS] 任务 {} 更新成功: {} -> {}", task.name, previous_ip.as_deref().unwrap_or("无"), detected_ip);
    Ok(())
}

/// 根据 credential_id 从 DNS 凭证存储中查找凭证（账号隔离校验）
fn find_dns_credential(
    app_handle: &tauri::AppHandle,
    username: &str,
    credential_id: &str,
) -> Result<DnsCredential, String> {
    let creds = dns_config::list_all_credentials(app_handle)?;
    creds
        .into_iter()
        .find(|c| c.id == credential_id && (c.owner_username.is_empty() || c.owner_username == username))
        .ok_or_else(|| format!("未找到凭证 {}", credential_id))
}

fn get_access_token(app_handle: &tauri::AppHandle) -> Result<String, String> {
    let state = app_handle
        .try_state::<UserTokenState>()
        .ok_or_else(|| "未找到用户登录状态".to_string())?;
    let guard = state.0.lock().map_err(|e| format!("锁错误: {}", e))?;
    guard
        .clone()
        .ok_or_else(|| "未登录或登录已过期".to_string())
}

fn build_chmlfrp_credential(access_token: &str) -> Result<DnsCredential, String> {
    if access_token.trim().is_empty() {
        return Err("未提供 access_token，请先登录".to_string());
    }
    Ok(DnsCredential {
        id: String::new(),
        name: String::new(),
        provider: DnsProviderKind::Chmlfrp,
        secret_id: String::new(),
        secret_key: String::new(),
        token: access_token.to_string(),
        api_token: String::new(),
        owner_username: String::new(),
    })
}
