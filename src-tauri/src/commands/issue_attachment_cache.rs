use crate::utils::get_app_data_dir;
use futures_util::StreamExt;
use reqwest::Url;
use sha2::{Digest, Sha256};
use std::io::Write;
use std::path::{Path, PathBuf};

const MAX_ATTACHMENT_BYTES: u64 = 110 * 1024 * 1024;
// CDN（如 EdgeOne）可能拒绝无 UA 请求并返回 403/挑战页，需携带浏览器风格 UA
const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) NodeSpeedTest/1.0 Chrome/126.0.0.0 Safari/537.36";
static CACHE_ACCESS: once_cell::sync::Lazy<tokio::sync::RwLock<()>> =
    once_cell::sync::Lazy::new(|| tokio::sync::RwLock::new(()));

fn account_cache_key(account: &str) -> String {
    hex::encode(Sha256::digest(account.trim().as_bytes()))
}

fn extension_for_mime(mime_type: &str) -> Result<&'static str, String> {
    match mime_type {
        "image/jpeg" => Ok("jpg"),
        "image/png" => Ok("png"),
        "image/gif" => Ok("gif"),
        "video/mp4" => Ok("mp4"),
        "video/x-matroska" => Ok("mkv"),
        _ => Err("不支持的工单附件类型".to_string()),
    }
}

fn is_compatible_response_mime(expected: &str, actual: &str) -> bool {
    let normalized = actual
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    normalized == expected.to_ascii_lowercase() || normalized == "application/octet-stream"
}

fn validate_download_url(raw_url: &str) -> Result<Url, String> {
    let url = Url::parse(raw_url).map_err(|_| "附件地址无效".to_string())?;
    if url.scheme() != "https" || url.host_str() != Some("api.cct.zdzz.top") {
        return Err("附件地址不在允许范围".to_string());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("附件地址不允许包含凭据".to_string());
    }
    Ok(url)
}

fn cache_path(
    root: &Path,
    account: &str,
    issue_id: u64,
    attachment_id: u64,
    mime_type: &str,
) -> Result<PathBuf, String> {
    if account.trim().is_empty() || issue_id == 0 || attachment_id == 0 {
        return Err("工单附件缓存参数无效".to_string());
    }
    let extension = extension_for_mime(mime_type)?;
    Ok(root
        .join("issue-attachments")
        .join(account_cache_key(account))
        .join(issue_id.to_string())
        .join(format!("{}.{}", attachment_id, extension)))
}

fn existing_cache_path(path: PathBuf) -> Option<String> {
    let metadata = std::fs::metadata(&path).ok()?;
    if metadata.is_file() && metadata.len() > 0 {
        Some(path.to_string_lossy().into_owned())
    } else {
        None
    }
}

#[tauri::command]
pub fn get_issue_attachment_cache_path(
    app_handle: tauri::AppHandle,
    account: String,
    issue_id: u64,
    attachment_id: u64,
    mime_type: String,
) -> Result<Option<String>, String> {
    let root = get_app_data_dir(&app_handle)?;
    let path = cache_path(&root, &account, issue_id, attachment_id, &mime_type)?;
    Ok(existing_cache_path(path))
}

#[tauri::command]
pub async fn cache_issue_attachment(
    app_handle: tauri::AppHandle,
    account: String,
    issue_id: u64,
    attachment_id: u64,
    mime_type: String,
    url: String,
) -> Result<String, String> {
    let result = cache_issue_attachment_inner(
        &app_handle,
        &account,
        issue_id,
        attachment_id,
        &mime_type,
        &url,
    )
    .await;
    if let Err(error) = &result {
        log::warn!(
            "工单附件缓存失败: issue_id={}, attachment_id={}, error={}",
            issue_id,
            attachment_id,
            error
        );
    }
    result
}

async fn cache_issue_attachment_inner(
    app_handle: &tauri::AppHandle,
    account: &str,
    issue_id: u64,
    attachment_id: u64,
    mime_type: &str,
    url: &str,
) -> Result<String, String> {
    let _access = CACHE_ACCESS.read().await;
    let root = get_app_data_dir(app_handle)?;
    let path = cache_path(&root, account, issue_id, attachment_id, mime_type)?;
    if let Some(existing) = existing_cache_path(path.clone()) {
        return Ok(existing);
    }

    let download_url = validate_download_url(url)?;
    let response = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(180))
        .build()
        .map_err(|e| format!("创建附件下载客户端失败: {}", e))?
        .get(download_url)
        .header(reqwest::header::USER_AGENT, USER_AGENT)
        .send()
        .await
        .map_err(|e| format!("下载工单附件失败: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("下载工单附件失败: HTTP {}", response.status()));
    }
    let response_mime = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    if !is_compatible_response_mime(mime_type, response_mime) {
        return Err(format!(
            "工单附件响应类型不匹配: 期望 {}，实际响应类型 {}",
            mime_type, response_mime
        ));
    }
    if response.content_length().unwrap_or(0) > MAX_ATTACHMENT_BYTES {
        return Err("工单附件超过本地缓存大小限制".to_string());
    }

    let parent = path
        .parent()
        .ok_or_else(|| "附件缓存路径无效".to_string())?;
    std::fs::create_dir_all(parent).map_err(|e| format!("创建附件缓存目录失败: {}", e))?;
    let temp_path = path.with_extension(format!("{}.part", extension_for_mime(mime_type)?));
    let mut file =
        std::fs::File::create(&temp_path).map_err(|e| format!("创建附件缓存文件失败: {}", e))?;
    let mut downloaded = 0u64;
    let mut stream = response.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("读取工单附件失败: {}", e))?;
        downloaded = downloaded.saturating_add(chunk.len() as u64);
        if downloaded > MAX_ATTACHMENT_BYTES {
            drop(file);
            let _ = std::fs::remove_file(&temp_path);
            return Err("工单附件超过本地缓存大小限制".to_string());
        }
        if let Err(error) = file.write_all(&chunk) {
            drop(file);
            let _ = std::fs::remove_file(&temp_path);
            return Err(format!("写入工单附件缓存失败: {}", error));
        }
    }

    file.sync_all()
        .map_err(|e| format!("保存工单附件缓存失败: {}", e))?;
    drop(file);
    if downloaded == 0 {
        let _ = std::fs::remove_file(&temp_path);
        return Err("工单附件内容为空".to_string());
    }
    std::fs::rename(&temp_path, &path).map_err(|e| {
        let _ = std::fs::remove_file(&temp_path);
        format!("完成工单附件缓存失败: {}", e)
    })?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn clear_issue_attachment_cache(app_handle: tauri::AppHandle) -> Result<u64, String> {
    let _access = CACHE_ACCESS.write().await;
    let root = get_app_data_dir(&app_handle)?.join("issue-attachments");
    if !root.exists() {
        return Ok(0);
    }
    let mut removed = 0u64;
    for entry in walk_files(&root)? {
        removed = removed.saturating_add(std::fs::metadata(&entry).map(|m| m.len()).unwrap_or(0));
    }
    std::fs::remove_dir_all(&root).map_err(|e| format!("清理工单附件缓存失败: {}", e))?;
    Ok(removed)
}

fn walk_files(root: &Path) -> Result<Vec<PathBuf>, String> {
    let mut files = Vec::new();
    let mut pending = vec![root.to_path_buf()];
    while let Some(dir) = pending.pop() {
        for entry in std::fs::read_dir(&dir).map_err(|e| format!("读取附件缓存目录失败: {}", e))?
        {
            let path = entry
                .map_err(|e| format!("读取附件缓存项失败: {}", e))?
                .path();
            if path.is_dir() {
                pending.push(path);
            } else if path.is_file() {
                files.push(path);
            }
        }
    }
    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_path_is_account_isolated_and_uses_known_extension() {
        let root = Path::new("cache-root");
        let first = cache_path(root, "alice", 10, 20, "image/png").unwrap();
        let second = cache_path(root, "bob", 10, 20, "image/png").unwrap();
        assert_ne!(first, second);
        assert!(first.ends_with(Path::new("10/20.png")));
    }

    #[test]
    fn rejects_unknown_mime_and_untrusted_urls() {
        assert!(extension_for_mime("text/html").is_err());
        assert!(validate_download_url("http://api.cct.zdzz.top/file").is_err());
        assert!(validate_download_url("https://example.com/file").is_err());
        assert!(validate_download_url("https://api.cct.zdzz.top/file").is_ok());
    }

    #[test]
    fn accepts_expected_or_generic_binary_response_mime() {
        assert!(is_compatible_response_mime(
            "image/png",
            "image/png; charset=binary"
        ));
        assert!(is_compatible_response_mime(
            "video/mp4",
            "application/octet-stream"
        ));
        assert!(!is_compatible_response_mime("image/png", "text/html"));
    }
}
