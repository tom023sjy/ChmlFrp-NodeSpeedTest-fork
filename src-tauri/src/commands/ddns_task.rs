// DDNS 动态解析任务配置与存储
// 任务结构包含：目标域名、监听网卡、调度模式（定时/分时段间隔）、启用状态、运行时状态
// 数据按账号隔离，存储于 ddns/tasks.json，日志存储于 ddns/logs.json
use std::path::PathBuf;

use chrono::{DateTime, Local, Utc};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use super::dns_config::{dns_data_dir, read_json};

/// 调度模式
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum ScheduleMode {
    /// 定时检查：每天固定时间点检查一次（支持多个时间点）
    /// times 格式：["08:00", "20:00"]
    Scheduled { times: Vec<String> },
    /// 间隔检查：按时间段设置不同频率
    /// 未匹配任何时间段时使用 fallback_interval_secs
    Intervals {
        intervals: Vec<TimeInterval>,
        /// 兜底间隔（秒），当当前时间不在任何时间段内时使用
        #[serde(default = "default_fallback_interval")]
        fallback_interval_secs: u64,
    },
}

/// 凭证来源
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum CredentialSource {
    /// 使用登录的 ChmlFrp accessToken
    Chmlfrp,
    /// 引用 DNS 凭证 ID（DNSPod/Aliyun/Cloudflare 等）
    Credential { credential_id: String },
}

fn default_fallback_interval() -> u64 {
    300
}

/// 时间段：在 start ~ end 之间按 interval_secs 间隔检查
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TimeInterval {
    /// 开始时间，格式 "HH:mm"
    pub start: String,
    /// 结束时间，格式 "HH:mm"
    pub end: String,
    /// 间隔秒数
    pub interval_secs: u64,
}

/// DDNS 任务
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DdnsTask {
    /// 唯一标识
    pub id: String,
    /// 任务名称
    pub name: String,
    /// 主域名（如 frp.wtf 或 example.com）
    pub domain: String,
    /// 子域名前缀（如 www）
    pub record: String,
    /// 记录类型：A / AAAA
    pub record_type: String,
    /// 凭证来源
    #[serde(default = "default_credential_source")]
    pub credential_source: CredentialSource,
    /// 监听的本机网卡名（空字符串表示自动选择默认网卡）
    #[serde(default)]
    pub interface: String,
    /// 调度模式
    pub schedule: ScheduleMode,
    /// 是否启用
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// 上次检查时间（本地时间 ISO 字符串）
    #[serde(default)]
    pub last_check: Option<String>,
    /// 上次检测到的 IP
    #[serde(default)]
    pub last_ip: Option<String>,
    /// 上次更新到的 IP（成功写入 DNS 的 IP）
    #[serde(default)]
    pub last_updated_ip: Option<String>,
    /// 上次检查结果信息
    #[serde(default)]
    pub last_message: Option<String>,
    /// 凭证所属用户名（账号隔离）
    #[serde(default)]
    pub owner_username: String,
}

fn default_credential_source() -> CredentialSource {
    CredentialSource::Chmlfrp
}

fn default_true() -> bool {
    true
}

/// DDNS 操作日志
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DdnsLog {
    /// 时间（本地时间 ISO 字符串）
    pub time: String,
    /// 任务 ID
    pub task_id: String,
    /// 任务名称
    pub task_name: String,
    /// 操作类型：check / update / error
    pub action: String,
    /// 检测到的 IP
    #[serde(default)]
    pub detected_ip: Option<String>,
    /// 更新前的 IP
    #[serde(default)]
    pub previous_ip: Option<String>,
    /// 更新后的 IP
    #[serde(default)]
    pub updated_ip: Option<String>,
    /// 附加信息
    #[serde(default)]
    pub message: String,
    /// 所属用户名
    #[serde(default)]
    pub owner_username: String,
}

const TASKS_FILE: &str = "ddns-tasks.json";
const LOGS_FILE: &str = "ddns-logs.json";
const MAX_LOGS: usize = 500;

fn write_json<T: Serialize + ?Sized>(path: &PathBuf, data: &T) -> Result<(), String> {
    let content = serde_json::to_string_pretty(data).map_err(|e| format!("序列化失败: {}", e))?;
    std::fs::write(path, content).map_err(|e| format!("写入文件失败: {}", e))
}

pub fn ddns_tasks_path(app_handle: &AppHandle) -> Result<PathBuf, String> {
    Ok(dns_data_dir(app_handle)?.join(TASKS_FILE))
}

pub fn ddns_logs_path(app_handle: &AppHandle) -> Result<PathBuf, String> {
    Ok(dns_data_dir(app_handle)?.join(LOGS_FILE))
}

// ===== 任务 CRUD =====

#[tauri::command]
pub async fn list_ddns_tasks(
    app_handle: AppHandle,
    username: String,
) -> Result<Vec<DdnsTask>, String> {
    let path = ddns_tasks_path(&app_handle)?;
    let list: Vec<DdnsTask> = read_json(&path, Vec::new());
    Ok(list
        .into_iter()
        .filter(|t| t.owner_username.is_empty() || t.owner_username == username)
        .collect())
}

#[tauri::command]
pub async fn save_ddns_task(
    app_handle: AppHandle,
    username: String,
    task: DdnsTask,
) -> Result<DdnsTask, String> {
    let path = ddns_tasks_path(&app_handle)?;
    let mut list: Vec<DdnsTask> = read_json(&path, Vec::new());

    let mut task = task;
    task.owner_username = username.clone();

    if let Some(idx) = list.iter().position(|t| t.id == task.id) {
        if !list[idx].owner_username.is_empty() && list[idx].owner_username != username {
            return Err("无权修改此任务".to_string());
        }
        list[idx] = task.clone();
    } else {
        list.push(task.clone());
    }
    write_json(&path, &list)?;
    Ok(task)
}

#[tauri::command]
pub async fn delete_ddns_task(
    app_handle: AppHandle,
    username: String,
    id: String,
) -> Result<(), String> {
    let path = ddns_tasks_path(&app_handle)?;
    let mut list: Vec<DdnsTask> = read_json(&path, Vec::new());
    if let Some(t) = list.iter().find(|t| t.id == id) {
        if !t.owner_username.is_empty() && t.owner_username != username {
            return Err("无权删除此任务".to_string());
        }
    }
    list.retain(|t| t.id != id);
    write_json(&path, &list)
}

/// 读取所有任务（调度器使用，不限用户）
pub fn read_all_tasks(app_handle: &AppHandle) -> Result<Vec<DdnsTask>, String> {
    let path = ddns_tasks_path(app_handle)?;
    Ok(read_json(&path, Vec::new()))
}

/// 写回任务（更新运行时状态：last_check / last_ip / last_message 等）
pub fn write_all_tasks(app_handle: &AppHandle, tasks: &[DdnsTask]) -> Result<(), String> {
    let path = ddns_tasks_path(app_handle)?;
    write_json(&path, tasks)
}

// ===== 日志 =====

#[tauri::command]
pub async fn list_ddns_logs(
    app_handle: AppHandle,
    username: String,
) -> Result<Vec<DdnsLog>, String> {
    let path = ddns_logs_path(&app_handle)?;
    let mut logs: Vec<DdnsLog> = read_json(&path, Vec::new());
    logs.retain(|l| l.owner_username.is_empty() || l.owner_username == username);
    // 最新的在前
    logs.sort_by(|a, b| b.time.cmp(&a.time));
    Ok(logs)
}

#[tauri::command]
pub async fn clear_ddns_logs(
    app_handle: AppHandle,
    username: String,
) -> Result<(), String> {
    let path = ddns_logs_path(&app_handle)?;
    let logs: Vec<DdnsLog> = read_json(&path, Vec::new());
    let retained: Vec<DdnsLog> = logs
        .into_iter()
        .filter(|l| !l.owner_username.is_empty() && l.owner_username != username)
        .collect();
    write_json(&path, &retained)
}

/// 追加日志（调度器使用）
pub fn append_log(app_handle: &AppHandle, mut log: DdnsLog) {
    if let Ok(path) = ddns_logs_path(app_handle) {
        log.time = Local::now().to_rfc3339();
        let mut logs: Vec<DdnsLog> = read_json(&path, Vec::new());
        logs.push(log);
        // 限制日志数量
        if logs.len() > MAX_LOGS {
            let drop_count = logs.len() - MAX_LOGS;
            logs.drain(0..drop_count);
        }
        let _ = write_json(&path, &logs);
    }
}

#[allow(dead_code)]
pub fn gen_id() -> String {
    format!(
        "{:x}{:x}",
        Local::now().timestamp_millis(),
        rand_u32()
    )
}

/// 简单伪随机（不引入 rand crate）
#[allow(dead_code)]
fn rand_u32() -> u32 {
    use std::time::SystemTime;
    let nanos = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    nanos.wrapping_mul(2654435761)
}

/// 将给定时间戳格式化为本地时间 ISO 字符串
pub fn format_local_time(dt: DateTime<Local>) -> String {
    dt.to_rfc3339()
}

/// 解析本地时间 ISO 字符串
pub fn parse_local_time(s: &str) -> Option<DateTime<Local>> {
    DateTime::parse_from_rfc3339(s).ok().map(|dt| dt.with_timezone(&Local))
}

/// UTC 时间转本地时间字符串（用于调度器比较）
#[allow(dead_code)]
pub fn utc_to_local_string(utc: DateTime<Utc>) -> String {
    utc.with_timezone(&Local).to_rfc3339()
}
