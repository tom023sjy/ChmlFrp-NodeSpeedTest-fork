// DNS 容灾配置与日志存储（SQLite 数据库 + 敏感字段加密）
// 数据表：dns_credentials / dns_tasks / dns_logs（建表脚本位于 db.rs）
// 敏感字段（secret_id/secret_key/token/api_token/user_token）经 crypto.rs 加密后入库
use crate::crypto;
use crate::db;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;

use super::dns_provider::{verify_credential, DnsCredential, DnsProviderKind};

/// 一个隧道目标（用于匹配监控的隧道与切换目标）
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelTarget {
    /// 隧道名（匹配 /tunnel 返回的 name 字段）
    pub tunnel_name: String,
    /// 隧道 ip 字段，切换时作为 CNAME 值
    pub cname_value: String,
    /// 备注（可选）
    #[serde(default)]
    pub note: String,
}

/// 一条 DNS 监控任务
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DnsMonitorTask {
    pub id: String,
    /// 任务名称
    pub name: String,
    /// 启用状态
    pub enabled: bool,
    /// 用户 token（调用 /tunnel 时使用，前端自动填入当前登录账户的 usertoken）
    pub user_token: String,
    /// DNS 凭证 ID
    pub credential_id: String,
    /// 主域名（如 example.com）
    pub domain: String,
    /// 子域名前缀（如 www）
    pub subdomain: String,
    /// 主隧道
    pub primary_tunnel: TunnelTarget,
    /// 备用隧道列表（按优先级排序，索引越小越优先）
    pub backup_tunnels: Vec<TunnelTarget>,
    /// 主隧道连续失败多少次后自动切换（默认 2）
    #[serde(default = "default_fail_threshold")]
    pub fail_threshold: u32,
    /// 主隧道恢复连续多少次后自动回切（默认 2）
    #[serde(default = "default_recover_threshold")]
    pub recover_threshold: u32,
    /// 轮询间隔（秒），默认 60，范围 10-3600
    #[serde(default = "default_poll_interval")]
    pub poll_interval_secs: u32,
    /// 启用的检测方式列表，可选值："tunnel_state" / "node_state" / "tcping"
    /// 旧任务无此字段时默认 ["tunnel_state", "node_state"]
    #[serde(default = "default_check_methods")]
    pub check_methods: Vec<String>,
    /// 多少种检测方式不通过时判定主隧道异常（1 到 check_methods.len()）
    /// 旧任务无此字段时默认 1
    #[serde(default = "default_fail_method_threshold")]
    pub fail_method_threshold: u32,
    /// tcping 检测超时时间（秒），范围 1-10
    /// 旧任务无此字段时默认 3
    #[serde(default = "default_tcping_timeout")]
    pub tcping_timeout_secs: u32,
    /// 任务所属用户名（账号隔离用，旧数据为空时视为所有用户可见）
    #[serde(default)]
    pub owner_username: String,
}

fn default_fail_threshold() -> u32 {
    2
}

fn default_recover_threshold() -> u32 {
    2
}

fn default_poll_interval() -> u32 {
    60
}

fn default_check_methods() -> Vec<String> {
    vec!["tunnel_state".to_string(), "node_state".to_string()]
}

fn default_fail_method_threshold() -> u32 {
    1
}

fn default_tcping_timeout() -> u32 {
    3
}

/// 任务运行时状态（仅内存）
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRuntime {
    /// 主隧道连续失败次数
    pub primary_fail_count: u32,
    /// 主隧道连续成功次数（用于回切）
    pub primary_success_count: u32,
    /// 当前激活的隧道名（主隧道或某个备用隧道）
    pub active_tunnel_name: String,
    /// 当前是否处于切换到备用隧道的状态
    pub failed_over: bool,
    /// 上次检查时间
    pub last_check: String,
    /// 上次检查结果
    pub last_result: String,
    /// 下次应检查的 unix 时间戳（0 表示立即检查）
    #[serde(default)]
    pub next_check_at: i64,
}

/// 一次切换日志
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DnsSwitchLog {
    pub id: String,
    pub task_id: String,
    pub task_name: String,
    /// 切换类型：failover（主切备）/ recover（备切回主）
    pub kind: String,
    pub from_tunnel: String,
    pub to_tunnel: String,
    pub cname_value: String,
    pub success: bool,
    pub message: String,
    pub time: String,
    /// 日志所属用户名（账号隔离用，旧数据为空时视为所有用户可见）
    #[serde(default)]
    pub owner_username: String,
}

// ===== 凭证管理命令 =====

/// 从 rusqlite 行构造 DnsCredential，自动解密 secret_id/secret_key/token/api_token
fn credential_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<DnsCredential> {
    let secret_id_enc: String = row.get("secret_id")?;
    let secret_key_enc: String = row.get("secret_key")?;
    let token_enc: String = row.get("token")?;
    let api_token_enc: String = row.get("api_token")?;
    let provider_str: String = row.get("provider")?;
    let provider: DnsProviderKind =
        serde_json::from_str(&provider_str).unwrap_or(DnsProviderKind::DnspodCn);
    Ok(DnsCredential {
        id: row.get("id")?,
        name: row.get("name")?,
        provider,
        secret_id: crypto::decrypt_string(&secret_id_enc).unwrap_or_default(),
        secret_key: crypto::decrypt_string(&secret_key_enc).unwrap_or_default(),
        token: crypto::decrypt_string(&token_enc).unwrap_or_default(),
        api_token: crypto::decrypt_string(&api_token_enc).unwrap_or_default(),
        owner_username: row.get("owner_username")?,
    })
}

/// 凭证查询字段列表（与 credential_from_row 保持一致）
const CREDENTIAL_COLUMNS: &str = "id, name, provider, secret_id, secret_key, token, api_token, owner_username";

/// 读取所有凭证（调度器内部使用，不限用户）
pub fn list_all_credentials(_app_handle: &tauri::AppHandle) -> Result<Vec<DnsCredential>, String> {
    let conn = db::get_conn()?;
    let mut stmt = conn
        .prepare(&format!("SELECT {} FROM dns_credentials", CREDENTIAL_COLUMNS))
        .map_err(|e| format!("查询凭证失败: {}", e))?;
    let rows = stmt
        .query_map([], credential_from_row)
        .map_err(|e| format!("读取凭证失败: {}", e))?;
    let mut list = Vec::new();
    for row in rows {
        if let Ok(c) = row {
            list.push(c);
        }
    }
    Ok(list)
}

/// 读取所有任务（调度器内部使用，不限用户）
pub fn list_all_tasks(_app_handle: &tauri::AppHandle) -> Result<Vec<DnsMonitorTask>, String> {
    let conn = db::get_conn()?;
    let mut stmt = conn
        .prepare(&format!("SELECT {} FROM dns_tasks", TASK_COLUMNS))
        .map_err(|e| format!("查询任务失败: {}", e))?;
    let rows = stmt
        .query_map([], task_from_row)
        .map_err(|e| format!("读取任务失败: {}", e))?;
    let mut list = Vec::new();
    for row in rows {
        if let Ok(t) = row {
            list.push(t);
        }
    }
    Ok(list)
}

/// 按 ID 读取单个任务（调度器内部使用）
pub fn get_task_by_id(_app_handle: &tauri::AppHandle, task_id: &str) -> Result<Option<DnsMonitorTask>, String> {
    let conn = db::get_conn()?;
    let mut stmt = conn
        .prepare(&format!("SELECT {} FROM dns_tasks WHERE id = ?", TASK_COLUMNS))
        .map_err(|e| format!("查询任务失败: {}", e))?;
    let mut rows = stmt
        .query_map([&task_id], task_from_row)
        .map_err(|e| format!("读取任务失败: {}", e))?;
    if let Some(row) = rows.next() {
        Ok(Some(row.map_err(|e| e.to_string())?))
    } else {
        Ok(None)
    }
}

#[tauri::command]
pub async fn list_dns_credentials(
    _app_handle: tauri::AppHandle,
    username: String,
) -> Result<Vec<DnsCredential>, String> {
    let conn = db::get_conn()?;
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {} FROM dns_credentials WHERE owner_username = ? OR owner_username = ''",
            CREDENTIAL_COLUMNS
        ))
        .map_err(|e| format!("查询凭证失败: {}", e))?;
    let rows = stmt
        .query_map([&username], credential_from_row)
        .map_err(|e| format!("读取凭证失败: {}", e))?;
    let mut list = Vec::new();
    for row in rows {
        if let Ok(c) = row {
            list.push(c);
        }
    }
    Ok(list)
}

/// 验证 DNS 凭证是否有效（执行一次轻量级「列出域名」调用）
/// 用于保存前校验，失败返回带服务商标识的错误信息
#[tauri::command]
pub async fn dns_verify_credential(credential: DnsCredential) -> Result<(), String> {
    verify_credential(&credential).await
}

#[tauri::command]
pub async fn save_dns_credential(
    _app_handle: tauri::AppHandle,
    username: String,
    credential: DnsCredential,
) -> Result<DnsCredential, String> {
    let conn = db::get_conn()?;
    // 强制设置 owner 为当前用户
    let mut credential = credential;
    credential.owner_username = username.clone();

    // 验证 owner：只能修改自己的凭证（旧数据 owner 为空时允许认领）
    let existing_owner: Option<String> = conn
        .query_row(
            "SELECT owner_username FROM dns_credentials WHERE id = ?",
            [&credential.id],
            |row| row.get(0),
        )
        .ok();
    if let Some(owner) = existing_owner {
        if !owner.is_empty() && owner != username {
            return Err("无权修改此凭证".to_string());
        }
    }

    // 加密敏感字段
    let secret_id = crypto::encrypt_string(&credential.secret_id)?;
    let secret_key = crypto::encrypt_string(&credential.secret_key)?;
    let token = crypto::encrypt_string(&credential.token)?;
    let api_token = crypto::encrypt_string(&credential.api_token)?;
    // provider 枚举序列化为 JSON 字符串（如 "dnspodCn"）
    let provider = serde_json::to_string(&credential.provider)
        .map_err(|e| format!("序列化 provider 失败: {}", e))?;

    conn.execute(
        "INSERT OR REPLACE INTO dns_credentials \
         (id, name, provider, secret_id, secret_key, token, api_token, owner_username) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        rusqlite::params![
            &credential.id,
            &credential.name,
            &provider,
            &secret_id,
            &secret_key,
            &token,
            &api_token,
            &credential.owner_username,
        ],
    )
    .map_err(|e| format!("保存凭证失败: {}", e))?;

    Ok(credential)
}

#[tauri::command]
pub async fn delete_dns_credential(
    _app_handle: tauri::AppHandle,
    username: String,
    id: String,
) -> Result<(), String> {
    let conn = db::get_conn()?;
    // 验证 owner：只能删除自己的凭证（旧数据 owner 为空时允许删除）
    let existing_owner: Option<String> = conn
        .query_row(
            "SELECT owner_username FROM dns_credentials WHERE id = ?",
            [&id],
            |row| row.get(0),
        )
        .ok();
    if let Some(owner) = existing_owner {
        if !owner.is_empty() && owner != username {
            return Err("无权删除此凭证".to_string());
        }
    }
    conn.execute(
        "DELETE FROM dns_credentials WHERE id = ? AND (owner_username = '' OR owner_username = ?)",
        rusqlite::params![&id, &username],
    )
    .map_err(|e| format!("删除凭证失败: {}", e))?;
    Ok(())
}

// ===== 任务管理命令 =====

/// 从 rusqlite 行构造 DnsMonitorTask，自动解密 user_token，反序列化复杂字段
fn task_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<DnsMonitorTask> {
    let user_token_enc: String = row.get("user_token")?;
    let primary_tunnel_str: String = row.get("primary_tunnel")?;
    let backup_tunnels_str: String = row.get("backup_tunnels")?;
    let check_methods_str: String = row.get("check_methods")?;
    let enabled: i64 = row.get("enabled")?;

    Ok(DnsMonitorTask {
        id: row.get("id")?,
        name: row.get("name")?,
        enabled: enabled != 0,
        user_token: crypto::decrypt_string(&user_token_enc).unwrap_or_default(),
        credential_id: row.get("credential_id")?,
        domain: row.get("domain")?,
        subdomain: row.get("subdomain")?,
        primary_tunnel: serde_json::from_str(&primary_tunnel_str).unwrap_or_else(|_| TunnelTarget {
            tunnel_name: String::new(),
            cname_value: String::new(),
            note: String::new(),
        }),
        backup_tunnels: serde_json::from_str(&backup_tunnels_str).unwrap_or_default(),
        fail_threshold: row.get("fail_threshold")?,
        recover_threshold: row.get("recover_threshold")?,
        poll_interval_secs: row.get("poll_interval_secs")?,
        check_methods: serde_json::from_str(&check_methods_str)
            .unwrap_or_else(|_| default_check_methods()),
        fail_method_threshold: row.get("fail_method_threshold")?,
        tcping_timeout_secs: row.get("tcping_timeout_secs")?,
        owner_username: row.get("owner_username")?,
    })
}

/// 任务查询字段列表（与 task_from_row 保持一致）
const TASK_COLUMNS: &str = "id, name, enabled, user_token, credential_id, domain, subdomain, \
     primary_tunnel, backup_tunnels, fail_threshold, recover_threshold, \
     poll_interval_secs, check_methods, fail_method_threshold, tcping_timeout_secs, owner_username";

#[tauri::command]
pub async fn list_dns_tasks(
    _app_handle: tauri::AppHandle,
    username: String,
) -> Result<Vec<DnsMonitorTask>, String> {
    let conn = db::get_conn()?;
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {} FROM dns_tasks WHERE owner_username = ? OR owner_username = ''",
            TASK_COLUMNS
        ))
        .map_err(|e| format!("查询任务失败: {}", e))?;
    let rows = stmt
        .query_map([&username], task_from_row)
        .map_err(|e| format!("读取任务失败: {}", e))?;
    let mut list = Vec::new();
    for row in rows {
        if let Ok(t) = row {
            list.push(t);
        }
    }
    Ok(list)
}

#[tauri::command]
pub async fn save_dns_task(
    _app_handle: tauri::AppHandle,
    username: String,
    task: DnsMonitorTask,
) -> Result<DnsMonitorTask, String> {
    let conn = db::get_conn()?;
    // 强制设置 owner 为当前用户
    let mut task = task;
    task.owner_username = username.clone();

    // 验证 owner：只能修改自己的任务（旧数据 owner 为空时允许认领）
    let existing_owner: Option<String> = conn
        .query_row(
            "SELECT owner_username FROM dns_tasks WHERE id = ?",
            [&task.id],
            |row| row.get(0),
        )
        .ok();
    if let Some(owner) = existing_owner {
        if !owner.is_empty() && owner != username {
            return Err("无权修改此任务".to_string());
        }
    }

    // 加密 user_token
    let user_token = crypto::encrypt_string(&task.user_token)?;
    // 序列化复杂字段为 JSON 字符串
    let primary_tunnel = serde_json::to_string(&task.primary_tunnel)
        .map_err(|e| format!("序列化 primary_tunnel 失败: {}", e))?;
    let backup_tunnels = serde_json::to_string(&task.backup_tunnels)
        .map_err(|e| format!("序列化 backup_tunnels 失败: {}", e))?;
    let check_methods = serde_json::to_string(&task.check_methods)
        .map_err(|e| format!("序列化 check_methods 失败: {}", e))?;

    conn.execute(
        "INSERT OR REPLACE INTO dns_tasks \
         (id, name, enabled, user_token, credential_id, domain, subdomain, \
          primary_tunnel, backup_tunnels, fail_threshold, recover_threshold, \
          poll_interval_secs, check_methods, fail_method_threshold, \
          tcping_timeout_secs, owner_username) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        rusqlite::params![
            &task.id,
            &task.name,
            if task.enabled { 1 } else { 0 },
            &user_token,
            &task.credential_id,
            &task.domain,
            &task.subdomain,
            &primary_tunnel,
            &backup_tunnels,
            task.fail_threshold as i64,
            task.recover_threshold as i64,
            task.poll_interval_secs as i64,
            &check_methods,
            task.fail_method_threshold as i64,
            task.tcping_timeout_secs as i64,
            &task.owner_username,
        ],
    )
    .map_err(|e| format!("保存任务失败: {}", e))?;

    Ok(task)
}

#[tauri::command]
pub async fn delete_dns_task(
    _app_handle: tauri::AppHandle,
    username: String,
    id: String,
) -> Result<(), String> {
    let conn = db::get_conn()?;
    // 验证 owner：只能删除自己的任务（旧数据 owner 为空时允许删除）
    let existing_owner: Option<String> = conn
        .query_row(
            "SELECT owner_username FROM dns_tasks WHERE id = ?",
            [&id],
            |row| row.get(0),
        )
        .ok();
    if let Some(owner) = existing_owner {
        if !owner.is_empty() && owner != username {
            return Err("无权删除此任务".to_string());
        }
    }
    conn.execute(
        "DELETE FROM dns_tasks WHERE id = ? AND (owner_username = '' OR owner_username = ?)",
        rusqlite::params![&id, &username],
    )
    .map_err(|e| format!("删除任务失败: {}", e))?;
    Ok(())
}

// ===== 日志管理命令 =====

/// 从 rusqlite 行构造 DnsSwitchLog
fn log_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<DnsSwitchLog> {
    let success: i64 = row.get("success")?;
    Ok(DnsSwitchLog {
        id: row.get("id")?,
        task_id: row.get("task_id")?,
        task_name: row.get("task_name")?,
        kind: row.get("kind")?,
        from_tunnel: row.get("from_tunnel")?,
        to_tunnel: row.get("to_tunnel")?,
        cname_value: row.get("cname_value")?,
        success: success != 0,
        message: row.get("message")?,
        time: row.get("time")?,
        owner_username: row.get("owner_username")?,
    })
}

#[tauri::command]
pub async fn list_dns_logs(
    _app_handle: tauri::AppHandle,
    username: String,
) -> Result<Vec<DnsSwitchLog>, String> {
    let conn = db::get_conn()?;
    let mut stmt = conn
        .prepare(
            "SELECT id, task_id, task_name, kind, from_tunnel, to_tunnel, \
                    cname_value, success, message, time, owner_username \
             FROM dns_logs \
             WHERE owner_username = ? OR owner_username = '' \
             ORDER BY time DESC LIMIT 500",
        )
        .map_err(|e| format!("查询日志失败: {}", e))?;
    let rows = stmt
        .query_map([&username], log_from_row)
        .map_err(|e| format!("读取日志失败: {}", e))?;
    let mut list = Vec::new();
    for row in rows {
        if let Ok(l) = row {
            list.push(l);
        }
    }
    Ok(list)
}

#[tauri::command]
pub async fn clear_dns_logs(
    _app_handle: tauri::AppHandle,
    username: String,
) -> Result<(), String> {
    let conn = db::get_conn()?;
    // 仅清空当前用户的日志，保留其他用户的日志
    conn.execute(
        "DELETE FROM dns_logs WHERE owner_username = ?",
        [&username],
    )
    .map_err(|e| format!("清空日志失败: {}", e))?;
    Ok(())
}

/// 内部接口：追加一条日志（不导出为 Tauri 命令）
/// 写入失败仅打印日志，不向上传递错误（避免影响监控主流程）
pub fn append_log(_app_handle: &tauri::AppHandle, log: DnsSwitchLog) {
    if let Err(e) = append_log_inner(&log) {
        eprintln!("写入 DNS 日志失败: {}", e);
    }
}

fn append_log_inner(log: &DnsSwitchLog) -> Result<(), String> {
    let conn = db::get_conn()?;
    conn.execute(
        "INSERT INTO dns_logs \
         (id, task_id, task_name, kind, from_tunnel, to_tunnel, cname_value, \
          success, message, time, owner_username) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        rusqlite::params![
            &log.id,
            &log.task_id,
            &log.task_name,
            &log.kind,
            &log.from_tunnel,
            &log.to_tunnel,
            &log.cname_value,
            if log.success { 1 } else { 0 },
            &log.message,
            &log.time,
            &log.owner_username,
        ],
    )
    .map_err(|e| format!("插入日志失败: {}", e))?;
    // 保留最近 500 条，避免日志无限增长
    conn.execute(
        "DELETE FROM dns_logs WHERE id NOT IN \
         (SELECT id FROM dns_logs ORDER BY time DESC LIMIT 500)",
        [],
    )
    .map_err(|e| format!("清理旧日志失败: {}", e))?;
    Ok(())
}

/// 内部接口：生成简易 ID（时间戳 + 随机后缀）
pub fn gen_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
    format!("{:x}", nanos)
}

// ===== 全局运行时状态管理 =====
/// 所有任务的运行时状态（任务 id -> TaskRuntime）
pub struct DnsRuntimeState(pub Mutex<std::collections::HashMap<String, TaskRuntime>>);

impl DnsRuntimeState {
    pub fn new() -> Self {
        Self(Mutex::new(std::collections::HashMap::new()))
    }
}

/// 当前登录用户的有效 access token（前端登录/刷新后推送）
/// 供 DNS 监控调度器请求 /tunnel 接口使用
pub struct UserTokenState(pub Mutex<Option<String>>);

impl UserTokenState {
    pub fn new() -> Self {
        Self(Mutex::new(None))
    }
}

/// 前端推送当前有效的 access token 给后端
#[tauri::command]
pub async fn set_user_token(
    state: tauri::State<'_, UserTokenState>,
    token: String,
) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    *guard = Some(token);
    Ok(())
}

#[tauri::command]
pub async fn list_dns_runtime(
    _app_handle: tauri::AppHandle,
    username: String,
    state: tauri::State<'_, DnsRuntimeState>,
) -> Result<std::collections::HashMap<String, TaskRuntime>, String> {
    // 任务列表改为从 DB 读取（已按 owner_username 过滤）
    let tasks: Vec<DnsMonitorTask> = {
        let conn = db::get_conn()?;
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {} FROM dns_tasks WHERE owner_username = ? OR owner_username = ''",
                TASK_COLUMNS
            ))
            .map_err(|e| format!("查询任务失败: {}", e))?;
        let rows = stmt
            .query_map([&username], task_from_row)
            .map_err(|e| format!("读取任务失败: {}", e))?;
        let mut list = Vec::new();
        for row in rows {
            if let Ok(t) = row {
                list.push(t);
            }
        }
        list
    };
    let guard = state.0.lock().map_err(|e| format!("获取运行时锁失败: {}", e))?;
    let mut result = std::collections::HashMap::new();
    for task in tasks {
        let rt = guard
            .get(&task.id)
            .cloned()
            .unwrap_or_else(|| TaskRuntime {
                active_tunnel_name: task.primary_tunnel.tunnel_name.clone(),
                ..Default::default()
            });
        result.insert(task.id, rt);
    }
    Ok(result)
}

// ===== TXT 记录清理 =====

/// TXT 记录条目（用于清理界面展示与删除）
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TxtRecordItem {
    /// 凭证 ID（ChmlFrp 用特殊标识）
    pub credential_id: String,
    /// 凭证显示名（如「ChmlFrp 免费域名」或「我的凭证（DNSPod.cn）」）
    pub credential_label: String,
    /// 主域名
    pub domain: String,
    /// 记录 ID（删除时使用）
    pub record_id: String,
    /// 记录名（子域名前缀，如 _acme-challenge）
    pub name: String,
    /// 记录值
    pub value: String,
}

/// 列出所有凭证（含 ChmlFrp 免费域名）下的全部 TXT 记录
/// 用于数据维护中的「清除遗留 TXT 解析」功能
#[tauri::command]
pub async fn dns_list_all_txt_records(
    app_handle: tauri::AppHandle,
    username: String,
    state: tauri::State<'_, UserTokenState>,
) -> Result<Vec<TxtRecordItem>, String> {
    let mut items = Vec::new();

    // 1. 遍历用户的所有 DNS 凭证（list_all_credentials 已适配 DB 版本，内部自动解密）
    let creds = list_all_credentials(&app_handle)?
        .into_iter()
        .filter(|c| c.owner_username.is_empty() || c.owner_username == username)
        .collect::<Vec<_>>();

    for cred in &creds {
        let label = format!("{}（{}）", cred.name, super::dns_provider::provider_label(cred.provider));
        // 列出该凭证下所有主域名
        let domains = match super::dns_provider::list_domains(cred).await {
            Ok(d) => d,
            Err(e) => {
                // 单个凭证失败不中断整体扫描，记录错误继续
                eprintln!("列出域名失败 [{}]: {}", label, e);
                continue;
            }
        };
        for domain in domains {
            // 列出该域名下所有记录（subdomain=None 表示全部）
            let records = match super::dns_provider::list_records(cred, &domain, None).await {
                Ok(r) => r,
                Err(e) => {
                    eprintln!("列出记录失败 [{} / {}]: {}", label, domain, e);
                    continue;
                }
            };
            for rec in records {
                if rec.record_type.eq_ignore_ascii_case("TXT") {
                    items.push(TxtRecordItem {
                        credential_id: cred.id.clone(),
                        credential_label: label.clone(),
                        domain: domain.clone(),
                        record_id: rec.record_id,
                        name: rec.name,
                        value: rec.value,
                    });
                }
            }
        }
    }

    // 2. ChmlFrp 免费域名（用当前登录账户的 accessToken）
    let access_token = {
        let guard = state.0.lock().map_err(|e| format!("锁错误: {}", e))?;
        guard.clone()
    };
    if let Some(token) = access_token {
        let chmlfrp_cred = super::dns_provider::DnsCredential {
            id: String::new(),
            name: String::new(),
            provider: super::dns_provider::DnsProviderKind::Chmlfrp,
            secret_id: String::new(),
            secret_key: String::new(),
            token: token.clone(),
            api_token: String::new(),
            owner_username: String::new(),
        };
        let label = "ChmlFrp 免费域名（当前登录账户）".to_string();
        if let Ok(domains) = super::dns_provider::list_domains(&chmlfrp_cred).await {
            for domain in domains {
                if let Ok(records) = super::dns_provider::list_records(&chmlfrp_cred, &domain, None).await {
                    for rec in records {
                        if rec.record_type.eq_ignore_ascii_case("TXT") {
                            items.push(TxtRecordItem {
                                credential_id: "__chmlfrp__".to_string(),
                                credential_label: label.clone(),
                                domain: domain.clone(),
                                record_id: rec.record_id,
                                name: rec.name,
                                value: rec.value,
                            });
                        }
                    }
                }
            }
        }
    }

    Ok(items)
}

/// 删除指定的 TXT 记录
#[tauri::command]
pub async fn dns_delete_txt_record(
    app_handle: tauri::AppHandle,
    username: String,
    credential_id: String,
    domain: String,
    record_id: String,
    state: tauri::State<'_, UserTokenState>,
) -> Result<(), String> {
    // ChmlFrp 免费域名特殊处理
    if credential_id == "__chmlfrp__" {
        let access_token = {
            let guard = state.0.lock().map_err(|e| format!("锁错误: {}", e))?;
            guard.clone().ok_or_else(|| "未登录或登录已过期".to_string())?
        };
        let cred = super::dns_provider::DnsCredential {
            id: String::new(),
            name: String::new(),
            provider: super::dns_provider::DnsProviderKind::Chmlfrp,
            secret_id: String::new(),
            secret_key: String::new(),
            token: access_token,
            api_token: String::new(),
            owner_username: String::new(),
        };
        return super::dns_provider::delete_record(&cred, &domain, &record_id).await;
    }

    // 查找用户凭证（账号隔离校验）
    let cred = list_all_credentials(&app_handle)?
        .into_iter()
        .find(|c| c.id == credential_id && (c.owner_username.is_empty() || c.owner_username == username))
        .ok_or_else(|| format!("未找到凭证: {}", credential_id))?;
    super::dns_provider::delete_record(&cred, &domain, &record_id).await
}
