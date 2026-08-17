// DDNS 动态解析任务配置与存储
// 任务结构包含：目标域名、监听网卡、调度模式（定时/分时段间隔）、启用状态、运行时状态
// 数据按账号隔离，存储于 SQLite 数据库（ddns_tasks / ddns_logs 表）
use chrono::{DateTime, Local, Utc};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::db;

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

/// 日志保留上限
const MAX_LOGS: i64 = 500;

// ===== 内部辅助：数据库行读取 =====

/// 从数据库行按列名读取一个值，错误统一转换为 String
fn get_col<T: rusqlite::types::FromSql>(row: &rusqlite::Row, name: &str) -> Result<T, String> {
    row.get::<_, T>(name)
        .map_err(|e| format!("读取字段 {} 失败: {}", name, e))
}

/// 任务表查询的字段列表（与 row_to_task 对应）
const TASK_COLUMNS: &str = "id, name, domain, record, record_type, credential_source, interface, \
     schedule, enabled, last_check, last_ip, last_updated_ip, last_message, owner_username";

/// 将数据库行转换为 DdnsTask
fn row_to_task(row: &rusqlite::Row) -> Result<DdnsTask, String> {
    let cred_str: String = get_col(row, "credential_source")?;
    let sched_str: String = get_col(row, "schedule")?;
    let enabled: i64 = get_col(row, "enabled")?;
    let credential_source = serde_json::from_str(&cred_str)
        .map_err(|e| format!("解析 credential_source 失败: {}", e))?;
    let schedule =
        serde_json::from_str(&sched_str).map_err(|e| format!("解析 schedule 失败: {}", e))?;
    Ok(DdnsTask {
        id: get_col(row, "id")?,
        name: get_col(row, "name")?,
        domain: get_col(row, "domain")?,
        record: get_col(row, "record")?,
        record_type: get_col(row, "record_type")?,
        credential_source,
        interface: get_col(row, "interface")?,
        schedule,
        enabled: enabled != 0,
        last_check: get_col(row, "last_check")?,
        last_ip: get_col(row, "last_ip")?,
        last_updated_ip: get_col(row, "last_updated_ip")?,
        last_message: get_col(row, "last_message")?,
        owner_username: get_col(row, "owner_username")?,
    })
}

/// 插入或替换一条任务（全量字段）
fn upsert_task(conn: &rusqlite::Connection, task: &DdnsTask) -> Result<(), String> {
    let cred_str = serde_json::to_string(&task.credential_source)
        .map_err(|e| format!("序列化 credential_source 失败: {}", e))?;
    let sched_str = serde_json::to_string(&task.schedule)
        .map_err(|e| format!("序列化 schedule 失败: {}", e))?;
    conn.execute(
        "INSERT OR REPLACE INTO ddns_tasks \
         (id, name, domain, record, record_type, credential_source, interface, schedule, \
          enabled, last_check, last_ip, last_updated_ip, last_message, owner_username) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        params![
            task.id,
            task.name,
            task.domain,
            task.record,
            task.record_type,
            cred_str,
            task.interface,
            sched_str,
            if task.enabled { 1 } else { 0 },
            task.last_check,
            task.last_ip,
            task.last_updated_ip,
            task.last_message,
            task.owner_username,
        ],
    )
    .map_err(|e| format!("写入任务失败: {}", e))?;
    Ok(())
}

/// 仅更新任务运行时状态字段（调度器回写用）
fn update_task_runtime(conn: &rusqlite::Connection, task: &DdnsTask) -> Result<(), String> {
    conn.execute(
        "UPDATE ddns_tasks SET last_check = ?, last_ip = ?, last_updated_ip = ?, last_message = ? \
         WHERE id = ?",
        params![
            task.last_check,
            task.last_ip,
            task.last_updated_ip,
            task.last_message,
            task.id,
        ],
    )
    .map_err(|e| format!("更新任务状态失败: {}", e))?;
    Ok(())
}

/// 删除某用户超过上限的旧日志，仅保留最近 MAX_LOGS 条
fn trim_logs(conn: &rusqlite::Connection, owner_username: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM ddns_logs WHERE owner_username = ? AND id NOT IN (\
         SELECT id FROM ddns_logs WHERE owner_username = ? ORDER BY id DESC LIMIT ?\
         )",
        params![owner_username, owner_username, MAX_LOGS],
    )
    .map_err(|e| format!("清理日志失败: {}", e))?;
    Ok(())
}

// ===== 任务 CRUD =====

#[tauri::command]
pub async fn list_ddns_tasks(
    _app_handle: AppHandle,
    username: String,
) -> Result<Vec<DdnsTask>, String> {
    let conn = db::get_conn()?;
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {} FROM ddns_tasks WHERE owner_username = '' OR owner_username = ?",
            TASK_COLUMNS
        ))
        .map_err(|e| format!("查询任务失败: {}", e))?;
    let mut rows = stmt
        .query(params![username])
        .map_err(|e| format!("查询任务失败: {}", e))?;
    let mut tasks = Vec::new();
    while let Some(row) = rows.next().map_err(|e| format!("读取任务失败: {}", e))? {
        tasks.push(row_to_task(row)?);
    }
    Ok(tasks)
}

#[tauri::command]
pub async fn save_ddns_task(
    _app_handle: AppHandle,
    username: String,
    task: DdnsTask,
) -> Result<DdnsTask, String> {
    let conn = db::get_conn()?;
    let mut task = task;
    task.owner_username = username.clone();

    // 权限校验：已存在的任务仅 owner 为空（旧数据）或等于当前用户时允许修改
    let existing_owner: Option<String> = conn
        .query_row(
            "SELECT owner_username FROM ddns_tasks WHERE id = ?",
            params![task.id],
            |row| row.get("owner_username"),
        )
        .optional()
        .map_err(|e| format!("查询任务失败: {}", e))?;
    if let Some(owner) = existing_owner {
        if !owner.is_empty() && owner != username {
            return Err("无权修改此任务".to_string());
        }
    }

    upsert_task(&conn, &task)?;
    Ok(task)
}

#[tauri::command]
pub async fn delete_ddns_task(
    _app_handle: AppHandle,
    username: String,
    id: String,
) -> Result<(), String> {
    let conn = db::get_conn()?;
    // 权限校验：owner 为空（旧数据）或等于当前用户时允许删除
    let existing_owner: Option<String> = conn
        .query_row(
            "SELECT owner_username FROM ddns_tasks WHERE id = ?",
            params![id],
            |row| row.get("owner_username"),
        )
        .optional()
        .map_err(|e| format!("查询任务失败: {}", e))?;
    if let Some(owner) = existing_owner {
        if !owner.is_empty() && owner != username {
            return Err("无权删除此任务".to_string());
        }
    }
    conn.execute(
        "DELETE FROM ddns_tasks WHERE id = ? AND (owner_username = '' OR owner_username = ?)",
        params![id, username],
    )
    .map_err(|e| format!("删除任务失败: {}", e))?;
    Ok(())
}

/// 读取所有任务（调度器使用，不限用户）
pub fn read_all_tasks(_app_handle: &AppHandle) -> Result<Vec<DdnsTask>, String> {
    let conn = db::get_conn()?;
    let mut stmt = conn
        .prepare(&format!("SELECT {} FROM ddns_tasks", TASK_COLUMNS))
        .map_err(|e| format!("查询任务失败: {}", e))?;
    let mut rows = stmt.query([]).map_err(|e| format!("查询任务失败: {}", e))?;
    let mut tasks = Vec::new();
    while let Some(row) = rows.next().map_err(|e| format!("读取任务失败: {}", e))? {
        tasks.push(row_to_task(row)?);
    }
    Ok(tasks)
}

/// 写回任务（更新运行时状态：last_check / last_ip / last_updated_ip / last_message）
pub fn write_all_tasks(_app_handle: &AppHandle, tasks: &[DdnsTask]) -> Result<(), String> {
    let conn = db::get_conn()?;
    for task in tasks {
        update_task_runtime(&conn, task)?;
    }
    Ok(())
}

// ===== 日志 =====

#[tauri::command]
pub async fn list_ddns_logs(
    _app_handle: AppHandle,
    username: String,
) -> Result<Vec<DdnsLog>, String> {
    let conn = db::get_conn()?;
    let mut stmt = conn
        .prepare(
            "SELECT time, task_id, task_name, action, detected_ip, previous_ip, updated_ip, \
             message, owner_username FROM ddns_logs \
             WHERE owner_username = '' OR owner_username = ? \
             ORDER BY time DESC LIMIT ?",
        )
        .map_err(|e| format!("查询日志失败: {}", e))?;
    let mut rows = stmt
        .query(params![username, MAX_LOGS])
        .map_err(|e| format!("查询日志失败: {}", e))?;
    let mut logs = Vec::new();
    while let Some(row) = rows.next().map_err(|e| format!("读取日志失败: {}", e))? {
        logs.push(DdnsLog {
            time: get_col(row, "time")?,
            task_id: get_col(row, "task_id")?,
            task_name: get_col(row, "task_name")?,
            action: get_col(row, "action")?,
            detected_ip: get_col(row, "detected_ip")?,
            previous_ip: get_col(row, "previous_ip")?,
            updated_ip: get_col(row, "updated_ip")?,
            message: get_col(row, "message")?,
            owner_username: get_col(row, "owner_username")?,
        });
    }
    Ok(logs)
}

#[tauri::command]
pub async fn clear_ddns_logs(_app_handle: AppHandle, username: String) -> Result<(), String> {
    let conn = db::get_conn()?;
    // 仅删除当前用户的日志，保留其他用户的日志
    conn.execute(
        "DELETE FROM ddns_logs WHERE owner_username = ?",
        params![username],
    )
    .map_err(|e| format!("清除日志失败: {}", e))?;
    Ok(())
}

/// 追加日志（调度器使用）
pub fn append_log(_app_handle: &AppHandle, mut log: DdnsLog) {
    log.time = Local::now().to_rfc3339();
    if let Err(e) = (|| -> Result<(), String> {
        let conn = db::get_conn()?;
        conn.execute(
            "INSERT INTO ddns_logs \
             (time, task_id, task_name, action, detected_ip, previous_ip, updated_ip, message, owner_username) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                log.time,
                log.task_id,
                log.task_name,
                log.action,
                log.detected_ip,
                log.previous_ip,
                log.updated_ip,
                log.message,
                log.owner_username,
            ],
        )
        .map_err(|e| format!("写入日志失败: {}", e))?;
        // 保留 500 条上限
        trim_logs(&conn, &log.owner_username)?;
        Ok(())
    })() {
        log::warn!("[DDNS] 追加日志失败: {}", e);
    }
}

#[allow(dead_code)]
pub fn gen_id() -> String {
    // 使用 UUID v4 保证全局唯一性，避免快速连续生成时的碰撞
    uuid::Uuid::new_v4().to_string()
}

/// 将给定时间戳格式化为本地时间 ISO 字符串
pub fn format_local_time(dt: DateTime<Local>) -> String {
    dt.to_rfc3339()
}

/// 解析本地时间 ISO 字符串
pub fn parse_local_time(s: &str) -> Option<DateTime<Local>> {
    DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|dt| dt.with_timezone(&Local))
}

/// UTC 时间转本地时间字符串（用于调度器比较）
#[allow(dead_code)]
pub fn utc_to_local_string(utc: DateTime<Utc>) -> String {
    utc.with_timezone(&Local).to_rfc3339()
}
