use crate::utils::get_app_data_dir;
use std::fs;
use std::path::Path;

/// 允许的视频扩展名白名单
const VIDEO_EXTS: &[&str] = &["mp4", "webm", "ogv", "mov"];
/// 允许的图片扩展名白名单
const IMAGE_EXTS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"];

/// 复制文件到 backgrounds 目录。
/// - 校验源文件扩展名必须在白名单内，防止把任意文件塞进 backgrounds 目录
///   被后续读取逻辑当作媒体文件读出造成信息泄露
/// - 用 file_name() 防路径穿越
fn copy_to_backgrounds(
    app_handle: &tauri::AppHandle,
    source_path: &str,
    allowed_exts: &[&str],
    kind_name: &str,
) -> Result<String, String> {
    let source = Path::new(source_path);

    // 校验扩展名
    let ext = source
        .extension()
        .ok_or_else(|| {
            format!(
                "无法识别文件扩展名，支持的{}格式: {}",
                kind_name,
                allowed_exts.join(", ")
            )
        })?
        .to_string_lossy()
        .to_lowercase();
    if !allowed_exts.contains(&ext.as_str()) {
        return Err(format!(
            "不支持的{}格式: .{}，支持的格式: {}",
            kind_name,
            ext,
            allowed_exts.join(", ")
        ));
    }

    // file_name() 已过滤路径分隔符，防穿越
    let file_name = source
        .file_name()
        .ok_or_else(|| "无法获取文件名".to_string())?
        .to_string_lossy()
        .to_string();

    let data_dir = get_app_data_dir(app_handle)?;
    let background_dir = data_dir.join("backgrounds");
    fs::create_dir_all(&background_dir).map_err(|e| e.to_string())?;

    let dest_path = background_dir.join(&file_name);
    fs::copy(source_path, &dest_path).map_err(|e| format!("复制文件失败: {}", e))?;

    Ok(dest_path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn copy_background_video(
    app_handle: tauri::AppHandle,
    source_path: String,
) -> Result<String, String> {
    copy_to_backgrounds(&app_handle, &source_path, VIDEO_EXTS, "视频")
}

#[tauri::command]
pub async fn copy_background_image(
    app_handle: tauri::AppHandle,
    source_path: String,
) -> Result<String, String> {
    copy_to_backgrounds(&app_handle, &source_path, IMAGE_EXTS, "图片")
}

#[tauri::command]
pub async fn get_background_video_path(
    app_handle: tauri::AppHandle,
) -> Result<Option<String>, String> {
    let data_dir = get_app_data_dir(&app_handle)?;
    let background_dir = data_dir.join("backgrounds");

    if !background_dir.exists() {
        return Ok(None);
    }

    for entry in fs::read_dir(&background_dir)
        .map_err(|e| e.to_string())?
        .flatten()
    {
        let path = entry.path();
        if path.is_file() {
            if let Some(ext) = path.extension() {
                let ext_lower = ext.to_string_lossy().to_lowercase();
                if VIDEO_EXTS.contains(&ext_lower.as_str()) {
                    return Ok(Some(path.to_string_lossy().to_string()));
                }
            }
        }
    }

    Ok(None)
}
