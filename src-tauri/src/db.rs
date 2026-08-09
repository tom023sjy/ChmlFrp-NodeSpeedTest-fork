/**
 * SQLite 嵌入式数据库模块
 *
 * 使用 rusqlite（bundled SQLite）替代 JSON 文件存储。
 * 数据库文件位于 $APPDATA/toolbox.db，通过 Mutex<Connection> 保证线程安全。
 *
 * 表结构：
 * - dns_credentials: DNS 凭证（敏感字段加密存储）
 * - dns_tasks: DNS 监控任务（user_token 加密）
 * - dns_logs: DNS 切换日志
 * - ddns_tasks: DDNS 动态解析任务
 * - ddns_logs: DDNS 操作日志
 * - ssl_logs: SSL 证书申请日志
 * - secure_storage: 安全存储（登录 token 等敏感数据，加密存储）
 */

use once_cell::sync::OnceCell;
use rusqlite::Connection;
use std::sync::Mutex;
use tauri::Manager;

/// 全局数据库连接（首次调用 init 后初始化）
static DB: OnceCell<Mutex<Connection>> = OnceCell::new();

/// 数据库文件名
const DB_FILE_NAME: &str = "toolbox.db";

/// 初始化数据库连接并创建表结构
/// 必须在应用启动时（setup 阶段）调用一次
pub fn init(app_handle: &tauri::AppHandle) -> Result<(), String> {
    let app_data = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取应用数据目录失败: {}", e))?;
    std::fs::create_dir_all(&app_data).map_err(|e| format!("创建数据目录失败: {}", e))?;

    let db_path = app_data.join(DB_FILE_NAME);
    log::info!("数据库已初始化: {}", DB_FILE_NAME);

    let conn = Connection::open(&db_path)
        .map_err(|e| format!("打开数据库失败: {}", e))?;

    // 启用 WAL 模式提升并发读性能
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")
        .map_err(|e| format!("设置数据库 PRAGMA 失败: {}", e))?;

    create_tables(&conn)?;

    DB.set(Mutex::new(conn))
        .map_err(|_| "数据库已初始化，不可重复调用".to_string())?;

    Ok(())
}

/// 创建所有表（IF NOT EXISTS，幂等）
fn create_tables(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "
        -- DNS 凭证表（敏感字段 secret_id/secret_key/token/api_token 加密存储）
        CREATE TABLE IF NOT EXISTS dns_credentials (
            id              TEXT PRIMARY KEY,
            name            TEXT NOT NULL,
            provider        TEXT NOT NULL,
            secret_id       TEXT NOT NULL DEFAULT '',
            secret_key      TEXT NOT NULL DEFAULT '',
            token           TEXT NOT NULL DEFAULT '',
            api_token       TEXT NOT NULL DEFAULT '',
            owner_username  TEXT NOT NULL
        );

        -- DNS 监控任务表（user_token 加密存储）
        CREATE TABLE IF NOT EXISTS dns_tasks (
            id                      TEXT PRIMARY KEY,
            name                    TEXT NOT NULL,
            enabled                 INTEGER NOT NULL DEFAULT 1,
            user_token              TEXT NOT NULL DEFAULT '',
            credential_id           TEXT NOT NULL DEFAULT '',
            domain                  TEXT NOT NULL DEFAULT '',
            subdomain               TEXT NOT NULL DEFAULT '',
            primary_tunnel          TEXT NOT NULL DEFAULT '{}',
            backup_tunnels          TEXT NOT NULL DEFAULT '[]',
            fail_threshold          INTEGER NOT NULL DEFAULT 3,
            recover_threshold       INTEGER NOT NULL DEFAULT 3,
            poll_interval_secs      INTEGER NOT NULL DEFAULT 60,
            check_methods           TEXT NOT NULL DEFAULT '[\"tunnel_state\"]',
            fail_method_threshold   INTEGER NOT NULL DEFAULT 3,
            tcping_timeout_secs     INTEGER NOT NULL DEFAULT 5,
            owner_username          TEXT NOT NULL
        );

        -- DNS 切换日志表
        CREATE TABLE IF NOT EXISTS dns_logs (
            id              TEXT PRIMARY KEY,
            task_id         TEXT NOT NULL,
            task_name       TEXT NOT NULL,
            kind            TEXT NOT NULL,
            from_tunnel     TEXT NOT NULL DEFAULT '',
            to_tunnel       TEXT NOT NULL DEFAULT '',
            cname_value     TEXT NOT NULL DEFAULT '',
            success         INTEGER NOT NULL DEFAULT 0,
            message         TEXT NOT NULL DEFAULT '',
            time            TEXT NOT NULL,
            owner_username  TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_dns_logs_owner_time ON dns_logs(owner_username, time DESC);

        -- DDNS 动态解析任务表
        CREATE TABLE IF NOT EXISTS ddns_tasks (
            id                  TEXT PRIMARY KEY,
            name                TEXT NOT NULL,
            domain              TEXT NOT NULL DEFAULT '',
            record              TEXT NOT NULL DEFAULT '',
            record_type         TEXT NOT NULL DEFAULT 'A',
            credential_source   TEXT NOT NULL DEFAULT '{\"type\":\"chmlfrp\"}',
            interface           TEXT NOT NULL DEFAULT '',
            schedule            TEXT NOT NULL DEFAULT '{\"type\":\"scheduled\",\"times\":[]}',
            enabled             INTEGER NOT NULL DEFAULT 1,
            last_check          TEXT,
            last_ip             TEXT,
            last_updated_ip     TEXT,
            last_message        TEXT,
            owner_username      TEXT NOT NULL
        );

        -- DDNS 操作日志表
        CREATE TABLE IF NOT EXISTS ddns_logs (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            time            TEXT NOT NULL,
            task_id         TEXT NOT NULL,
            task_name       TEXT NOT NULL,
            action          TEXT NOT NULL,
            detected_ip     TEXT,
            previous_ip     TEXT,
            updated_ip      TEXT,
            message         TEXT NOT NULL DEFAULT '',
            owner_username  TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_ddns_logs_owner_time ON ddns_logs(owner_username, time DESC);

        -- SSL 证书申请日志表
        CREATE TABLE IF NOT EXISTS ssl_logs (
            id              TEXT PRIMARY KEY,
            domains         TEXT NOT NULL DEFAULT '',
            provider        TEXT NOT NULL DEFAULT '',
            final_status    TEXT NOT NULL DEFAULT 'pending',
            logs            TEXT NOT NULL DEFAULT '[]',
            created_at      TEXT NOT NULL,
            finished_at     TEXT,
            owner_username  TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_ssl_logs_owner_time ON ssl_logs(owner_username, created_at DESC);

        -- 安全存储表（登录 token 等敏感数据，值加密存储）
        CREATE TABLE IF NOT EXISTS secure_storage (
            key             TEXT PRIMARY KEY,
            encrypted_value TEXT NOT NULL,
            updated_at      TEXT NOT NULL
        );
        ",
    )
    .map_err(|e| format!("创建数据库表失败: {}", e))?;

    Ok(())
}

/// 获取数据库连接的 MutexGuard
/// 调用前必须已调用 init()
pub fn get_conn() -> Result<std::sync::MutexGuard<'static, Connection>, String> {
    DB.get()
        .ok_or_else(|| "数据库未初始化".to_string())?
        .lock()
        .map_err(|e| format!("获取数据库锁失败: {}", e))
}


