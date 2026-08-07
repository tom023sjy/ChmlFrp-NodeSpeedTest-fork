/**
 * JSON → SQLite 数据迁移模块
 *
 * 应用启动时自动检测旧 JSON 文件，导入到数据库后重命名为 .bak。
 * 仅在对应数据库表为空时执行迁移，避免重复导入。
 * 迁移过程中敏感字段（DNS 密钥、token）会自动加密后写入数据库。
 */

use crate::commands::dns_provider::DnsCredential;
use crate::commands::dns_config::{DnsMonitorTask, DnsSwitchLog};
use crate::commands::ddns_task::{DdnsTask, DdnsLog};
use crate::commands::ssl_manager::SslRequestLog;
use crate::crypto;
use crate::db;
use crate::utils::get_app_data_dir;
use rusqlite::params;
use serde::Deserialize;
use std::path::PathBuf;

/// 执行迁移：检查旧 JSON 文件并导入到数据库
/// 在 db::init() 之后调用
pub fn run(app_handle: &tauri::AppHandle) {
    let app_data = match get_app_data_dir(app_handle) {
        Ok(p) => p,
        Err(e) => {
            log::warn!("迁移：获取数据目录失败: {}", e);
            return;
        }
    };

    let dns_dir = app_data.join("dns-failover");
    let ssl_dir = app_data.join("ssl");

    // 逐个迁移，单个失败不影响其他
    migrate_dns_credentials(&dns_dir.join("dns-credentials.json"));
    migrate_dns_tasks(&dns_dir.join("dns-tasks.json"));
    migrate_dns_logs(&dns_dir.join("dns-logs.json"));
    migrate_ddns_tasks(&dns_dir.join("ddns-tasks.json"));
    migrate_ddns_logs(&dns_dir.join("ddns-logs.json"));
    migrate_ssl_logs(&ssl_dir.join("ssl-logs.json"));
}

/// 读取 JSON 文件并反序列化
fn read_json_file<T: for<'de> Deserialize<'de>>(path: &PathBuf) -> Option<T> {
    let content = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&content).ok()
}

/// 迁移完成后将 JSON 文件重命名为 .bak
fn rename_to_bak(path: &PathBuf) {
    let bak = path.with_extension("json.bak");
    let _ = std::fs::rename(path, &bak);
}

/// 检查表是否为空
fn is_table_empty(table: &str) -> bool {
    match db::get_conn() {
        Ok(conn) => {
            let count: i64 = conn
                .query_row(&format!("SELECT COUNT(*) FROM {}", table), [], |row| {
                    row.get(0)
                })
                .unwrap_or(0);
            count == 0
        }
        Err(_) => true,
    }
}

fn migrate_dns_credentials(path: &PathBuf) {
    if !path.exists() || !is_table_empty("dns_credentials") {
        return;
    }
    log::info!("迁移: dns-credentials.json → 数据库");
    let list: Vec<DnsCredential> = match read_json_file(path) {
        Some(v) => v,
        None => return,
    };
    if let Ok(conn) = db::get_conn() {
        for cred in &list {
            // 加密敏感字段
            let secret_id = crypto::encrypt_string(&cred.secret_id).unwrap_or_default();
            let secret_key = crypto::encrypt_string(&cred.secret_key).unwrap_or_default();
            let token = crypto::encrypt_string(&cred.token).unwrap_or_default();
            let api_token = crypto::encrypt_string(&cred.api_token).unwrap_or_default();
            let provider = serde_json::to_string(&cred.provider).unwrap_or_default();
            let _ = conn.execute(
                "INSERT OR IGNORE INTO dns_credentials \
                 (id, name, provider, secret_id, secret_key, token, api_token, owner_username) \
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                params![&cred.id, &cred.name, &provider, &secret_id, &secret_key, &token, &api_token, &cred.owner_username],
            );
        }
    }
    rename_to_bak(path);
}

fn migrate_dns_tasks(path: &PathBuf) {
    if !path.exists() || !is_table_empty("dns_tasks") {
        return;
    }
    log::info!("迁移: dns-tasks.json → 数据库");
    let list: Vec<DnsMonitorTask> = match read_json_file(path) {
        Some(v) => v,
        None => return,
    };
    if let Ok(conn) = db::get_conn() {
        for t in &list {
            let user_token = crypto::encrypt_string(&t.user_token).unwrap_or_default();
            let primary_tunnel = serde_json::to_string(&t.primary_tunnel).unwrap_or_default();
            let backup_tunnels = serde_json::to_string(&t.backup_tunnels).unwrap_or_default();
            let check_methods = serde_json::to_string(&t.check_methods).unwrap_or_default();
            let _ = conn.execute(
                "INSERT OR IGNORE INTO dns_tasks \
                 (id, name, enabled, user_token, credential_id, domain, subdomain, \
                  primary_tunnel, backup_tunnels, fail_threshold, recover_threshold, \
                  poll_interval_secs, check_methods, fail_method_threshold, \
                  tcping_timeout_secs, owner_username) \
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                params![&t.id, &t.name, if t.enabled { 1 } else { 0 }, &user_token,
                        &t.credential_id, &t.domain, &t.subdomain,
                        &primary_tunnel, &backup_tunnels, &t.fail_threshold, &t.recover_threshold,
                        &t.poll_interval_secs, &check_methods, &t.fail_method_threshold,
                        &t.tcping_timeout_secs, &t.owner_username],
            );
        }
    }
    rename_to_bak(path);
}

fn migrate_dns_logs(path: &PathBuf) {
    if !path.exists() || !is_table_empty("dns_logs") {
        return;
    }
    log::info!("迁移: dns-logs.json → 数据库");
    let list: Vec<DnsSwitchLog> = match read_json_file(path) {
        Some(v) => v,
        None => return,
    };
    if let Ok(conn) = db::get_conn() {
        for l in &list {
            let _ = conn.execute(
                "INSERT OR IGNORE INTO dns_logs \
                 (id, task_id, task_name, kind, from_tunnel, to_tunnel, cname_value, \
                  success, message, time, owner_username) \
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                params![&l.id, &l.task_id, &l.task_name, &l.kind,
                        &l.from_tunnel, &l.to_tunnel, &l.cname_value,
                        if l.success { 1 } else { 0 }, &l.message, &l.time, &l.owner_username],
            );
        }
    }
    rename_to_bak(path);
}

fn migrate_ddns_tasks(path: &PathBuf) {
    if !path.exists() || !is_table_empty("ddns_tasks") {
        return;
    }
    log::info!("迁移: ddns-tasks.json → 数据库");
    let list: Vec<DdnsTask> = match read_json_file(path) {
        Some(v) => v,
        None => return,
    };
    if let Ok(conn) = db::get_conn() {
        for t in &list {
            let credential_source = serde_json::to_string(&t.credential_source).unwrap_or_default();
            let schedule = serde_json::to_string(&t.schedule).unwrap_or_default();
            let _ = conn.execute(
                "INSERT OR IGNORE INTO ddns_tasks \
                 (id, name, domain, record, record_type, credential_source, interface, \
                  schedule, enabled, last_check, last_ip, last_updated_ip, last_message, owner_username) \
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                params![&t.id, &t.name, &t.domain, &t.record, &t.record_type,
                        &credential_source, &t.interface, &schedule,
                        if t.enabled { 1 } else { 0 },
                        &t.last_check, &t.last_ip, &t.last_updated_ip, &t.last_message,
                        &t.owner_username],
            );
        }
    }
    rename_to_bak(path);
}

fn migrate_ddns_logs(path: &PathBuf) {
    if !path.exists() || !is_table_empty("ddns_logs") {
        return;
    }
    log::info!("迁移: ddns-logs.json → 数据库");
    let list: Vec<DdnsLog> = match read_json_file(path) {
        Some(v) => v,
        None => return,
    };
    if let Ok(conn) = db::get_conn() {
        for l in &list {
            let _ = conn.execute(
                "INSERT INTO ddns_logs \
                 (time, task_id, task_name, action, detected_ip, previous_ip, updated_ip, \
                  message, owner_username) \
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                params![&l.time, &l.task_id, &l.task_name, &l.action,
                        &l.detected_ip, &l.previous_ip, &l.updated_ip,
                        &l.message, &l.owner_username],
            );
        }
    }
    rename_to_bak(path);
}

fn migrate_ssl_logs(path: &PathBuf) {
    if !path.exists() || !is_table_empty("ssl_logs") {
        return;
    }
    log::info!("迁移: ssl-logs.json → 数据库");
    let list: Vec<SslRequestLog> = match read_json_file(path) {
        Some(v) => v,
        None => return,
    };
    if let Ok(conn) = db::get_conn() {
        for l in &list {
            let logs_json = serde_json::to_string(&l.logs).unwrap_or_else(|_| "[]".to_string());
            let _ = conn.execute(
                "INSERT OR IGNORE INTO ssl_logs \
                 (id, domains, provider, final_status, logs, created_at, finished_at, owner_username) \
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                params![&l.id, &l.domains, &l.provider, &l.final_status,
                        &logs_json, &l.created_at, &l.finished_at, &l.owner_username],
            );
        }
    }
    rename_to_bak(path);
}
