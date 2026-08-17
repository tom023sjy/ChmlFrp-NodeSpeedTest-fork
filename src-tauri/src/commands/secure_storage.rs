/**
 * 安全存储命令模块
 *
 * 将敏感数据（登录 token 等）加密后存储在数据库 secure_storage 表中。
 * 加密使用 DPAPI（Windows）或 AES-256-GCM（非 Windows），由 crypto 模块统一处理。
 * 前端通过 Tauri invoke 调用这些命令，替代明文 localStorage。
 */
use crate::crypto;
use crate::db;
use chrono::Local;

/// 存储一个键值对（值加密后存入数据库）
/// 如果 value 为空，则删除该键
#[tauri::command]
pub async fn secure_store(key: String, value: String) -> Result<(), String> {
    if value.is_empty() {
        return secure_delete(key).await;
    }
    let encrypted = crypto::encrypt_string(&value)?;
    let now = Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
    let conn = db::get_conn()?;
    conn.execute(
        "INSERT OR REPLACE INTO secure_storage (key, encrypted_value, updated_at) VALUES (?, ?, ?)",
        rusqlite::params![&key, &encrypted, &now],
    )
    .map_err(|e| format!("写入安全存储失败: {}", e))?;
    Ok(())
}

/// 读取一个键的值（解密后返回）
/// 键不存在时返回空字符串
#[tauri::command]
pub async fn secure_load(key: String) -> Result<String, String> {
    let conn = db::get_conn()?;
    let result: Option<String> = conn
        .query_row(
            "SELECT encrypted_value FROM secure_storage WHERE key = ?",
            [&key],
            |row| row.get(0),
        )
        .ok();
    match result {
        Some(encrypted) => crypto::decrypt_string(&encrypted),
        None => Ok(String::new()),
    }
}

/// 删除一个键
#[tauri::command]
pub async fn secure_delete(key: String) -> Result<(), String> {
    let conn = db::get_conn()?;
    conn.execute("DELETE FROM secure_storage WHERE key = ?", [&key])
        .map_err(|e| format!("删除安全存储失败: {}", e))?;
    Ok(())
}
