//! 设备互联 RPC 命令处理器
//!
//! 这些命令由本机执行，结果通过 WebSocket 中继返回给管理端。
//! 命令协议见 `backend/docs/设备互联API需求.md` 第六章。
//!
//! 命令清单：
//! - `relay_ping`：ICMP 延迟（多次测试，返回 rtts/min/avg/max/loss）
//! - `relay_tcping`：TCP 连接延迟（多次测试，返回 rtts/avg/loss）
//! - `relay_node_latency`：组合命令（ping + tcping）
//! - `relay_speedtest`：HTTP 带宽测试（下载/上传，进度推送）
//! - `relay_delete_my_data`：桌面端不支持，返回 NOT_SUPPORTED

use std::net::{TcpStream, ToSocketAddrs};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use log::{info, warn};
use regex::Regex;
use tauri::Emitter;

// ===== 结果结构（与 API 需求文档 6.1-6.4 对齐，camelCase 序列化）=====

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PingStat {
    pub rtts: Vec<f64>,
    pub min: Option<f64>,
    pub avg: Option<f64>,
    pub max: Option<f64>,
    pub loss: u32,
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TcpingStat {
    pub rtts: Vec<f64>,
    pub avg: Option<f64>,
    pub loss: u32,
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NodeLatencyResult {
    pub ping: PingStat,
    pub tcping: TcpingStat,
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SpeedtestResult {
    pub success: bool,
    pub download_speed_mbps: f64,
    pub upload_speed_mbps: f64,
    pub latency_ms: Option<f64>,
    pub jitter_ms: Option<f64>,
    pub error: Option<String>,
}

/// 进度推送事件 payload（前端据此调用 relay.reportProgress）
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SpeedtestProgressPayload {
    pub request_id: String,
    pub progress: f64,
    pub stage: String,
    pub speed_mbps: f64,
}

// ===== ping 实现 =====

/// 执行系统 ping 命令并解析每次 reply 的 rtt
///
/// 返回 (rtts, loss_count)
/// - rtts：每次成功 reply 的延迟（毫秒）
/// - loss_count：丢失次数
fn run_ping(host: &str, count: u32) -> (Vec<f64>, u32) {
    #[cfg(target_os = "windows")]
    let output = Command::new("ping")
        .arg("-n")
        .arg(count.to_string())
        .arg("-w")
        .arg("3000")
        .arg(host)
        .output();

    #[cfg(target_os = "macos")]
    let output = Command::new("ping")
        .arg("-c")
        .arg(count.to_string())
        .arg("-W")
        .arg("3000")
        .arg(host)
        .output();

    #[cfg(target_os = "linux")]
    let output = Command::new("ping")
        .arg("-c")
        .arg(count.to_string())
        .arg("-W")
        .arg("3")
        .arg(host)
        .output();

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    let output: Result<std::process::Output, std::io::Error> = Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "Ping not supported on this platform",
    ));

    let output = match output {
        Ok(o) => o,
        Err(_) => return (vec![], count),
    };

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut rtts: Vec<f64> = Vec::new();

    // Windows: "来自 1.2.3.4 的回复: 字节=32 时间=35ms TTL=64"
    //         "Reply from 1.2.3.4: bytes=32 time=35ms TTL=64"
    #[cfg(target_os = "windows")]
    {
        let re = Regex::new(r"time[=<]\s*(\d+(?:\.\d+)?)\s*ms").unwrap();
        for cap in re.captures_iter(&stdout) {
            if let Ok(v) = cap[1].parse::<f64>() {
                rtts.push(v);
            }
        }
    }

    // macOS / Linux: "64 bytes from 1.2.3.4: icmp_seq=1 ttl=64 time=35.2 ms"
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        let re = Regex::new(r"time[=<]\s*(\d+(?:\.\d+)?)\s*ms").unwrap();
        for cap in re.captures_iter(&stdout) {
            if let Ok(v) = cap[1].parse::<f64>() {
                rtts.push(v);
            }
        }
    }

    let received = rtts.len() as u32;
    let loss = count.saturating_sub(received);
    (rtts, loss)
}

fn build_ping_stat(rtts: Vec<f64>, loss: u32) -> PingStat {
    if rtts.is_empty() {
        return PingStat { rtts: vec![], min: None, avg: None, max: None, loss };
    }
    let min = rtts.iter().cloned().fold(f64::INFINITY, f64::min);
    let max = rtts.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    let avg = rtts.iter().sum::<f64>() / rtts.len() as f64;
    PingStat { rtts, min: Some(min), avg: Some(avg), max: Some(max), loss }
}

#[tauri::command]
pub async fn relay_ping(host: String, count: Option<u32>) -> Result<PingStat, String> {
    let count = count.unwrap_or(4);
    info!("[relay] ping {} count={}", host, count);
    let (rtts, loss) = tokio::task::spawn_blocking(move || run_ping(&host, count))
        .await
        .map_err(|e| format!("Task join error: {}", e))?;
    Ok(build_ping_stat(rtts, loss))
}

// ===== tcping 实现 =====

/// 执行单次 TCP 连接，返回延迟（毫秒）
fn tcping_once(host: &str, port: u16, timeout_secs: u64) -> Result<f64, String> {
    let addr_str = format!("{}:{}", host, port);
    let socket_addr = addr_str
        .to_socket_addrs()
        .map_err(|e| format!("解析地址失败: {}", e))?
        .next()
        .ok_or_else(|| "无法解析主机地址".to_string())?;
    let start = Instant::now();
    match TcpStream::connect_timeout(&socket_addr, Duration::from_secs(timeout_secs)) {
        Ok(_) => Ok(start.elapsed().as_secs_f64() * 1000.0),
        Err(e) => Err(format!("TCP 连接失败: {}", e)),
    }
}

#[tauri::command]
pub async fn relay_tcping(
    host: String,
    port: u16,
    count: Option<u32>,
    timeout_secs: Option<u64>,
) -> Result<TcpingStat, String> {
    let count = count.unwrap_or(4);
    let timeout = timeout_secs.unwrap_or(3);
    info!("[relay] tcping {}:{} count={}", host, port, count);

    tokio::task::spawn_blocking(move || {
        let mut rtts: Vec<f64> = Vec::new();
        let mut loss = 0u32;
        for _ in 0..count {
            match tcping_once(&host, port, timeout) {
                Ok(ms) => rtts.push(ms),
                Err(_) => loss += 1,
            }
        }
        let avg = if rtts.is_empty() {
            None
        } else {
            Some(rtts.iter().sum::<f64>() / rtts.len() as f64)
        };
        Ok(TcpingStat { rtts, avg, loss })
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

// ===== node_latency 组合命令 =====

#[tauri::command]
pub async fn relay_node_latency(
    node: String,
    port: u16,
    count: Option<u32>,
) -> Result<NodeLatencyResult, String> {
    let count = count.unwrap_or(4);
    info!("[relay] node_latency {}:{} count={}", node, port, count);

    let node_clone = node.clone();
    let ping_handle = tokio::task::spawn_blocking(move || run_ping(&node_clone, count));
    let tcping_handle = tokio::task::spawn_blocking(move || {
        let mut rtts: Vec<f64> = Vec::new();
        let mut loss = 0u32;
        for _ in 0..count {
            match tcping_once(&node, port, 3) {
                Ok(ms) => rtts.push(ms),
                Err(_) => loss += 1,
            }
        }
        let avg = if rtts.is_empty() {
            None
        } else {
            Some(rtts.iter().sum::<f64>() / rtts.len() as f64)
        };
        TcpingStat { rtts, avg, loss }
    });

    let (rtts, loss) = ping_handle
        .await
        .map_err(|e| format!("ping join error: {}", e))?;
    let ping_stat = build_ping_stat(rtts, loss);

    let tcping_stat = tcping_handle
        .await
        .map_err(|e| format!("tcping join error: {}", e))?;

    Ok(NodeLatencyResult { ping: ping_stat, tcping: tcping_stat })
}

// ===== speedtest 带宽测试 =====

const SPEEDTEST_PROGRESS_EVENT: &str = "relay-speedtest-progress";
const SPEEDTEST_CHUNK_SIZE: usize = 64 * 1024;
const SPEEDTEST_REPORT_INTERVAL: Duration = Duration::from_millis(200);

#[tauri::command]
pub async fn relay_speedtest(
    app_handle: tauri::AppHandle,
    request_id: String,
    url: String,
    direction: String,
    duration_secs: Option<u32>,
    threads: Option<u32>,
) -> Result<SpeedtestResult, String> {
    let duration_secs = duration_secs.unwrap_or(10).min(60);
    let _threads = threads.unwrap_or(4).max(1).min(16);
    info!(
        "[relay] speedtest url={} direction={} duration={}s",
        url, direction, duration_secs
    );

    let cancel_flag = Arc::new(AtomicBool::new(false));
    let cancel_clone = cancel_flag.clone();
    // 命令超时兜底：duration + 10s 缓冲
    let timeout_handle = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs((duration_secs + 10) as u64)).await;
        cancel_clone.store(true, Ordering::SeqCst);
    });

    let result = match direction.as_str() {
        "download" | "both" => {
            run_download_speedtest(app_handle.clone(), &request_id, &url, duration_secs, cancel_flag.clone()).await
        }
        "upload" => {
            run_upload_speedtest(app_handle.clone(), &request_id, &url, duration_secs, cancel_flag.clone()).await
        }
        _ => Err(format!("不支持的方向: {}（可选 download/upload/both）", direction)),
    };

    timeout_handle.abort();

    match result {
        Ok((download_mbps, upload_mbps)) => {
            Ok(SpeedtestResult {
                success: true,
                download_speed_mbps: download_mbps,
                upload_speed_mbps: upload_mbps,
                latency_ms: None,
                jitter_ms: None,
                error: None,
            })
        }
        Err(e) => {
            warn!("[relay] speedtest 失败: {}", e);
            Ok(SpeedtestResult {
                success: false,
                download_speed_mbps: 0.0,
                upload_speed_mbps: 0.0,
                latency_ms: None,
                jitter_ms: None,
                error: Some(e),
            })
        }
    }
}

/// 发送进度事件到前端
fn emit_progress(
    app_handle: &tauri::AppHandle,
    request_id: &str,
    progress: f64,
    stage: &str,
    speed_mbps: f64,
) {
    let _ = app_handle.emit(
        SPEEDTEST_PROGRESS_EVENT,
        SpeedtestProgressPayload {
            request_id: request_id.to_string(),
            progress,
            stage: stage.to_string(),
            speed_mbps,
        },
    );
}

/// 下载测速：GET url，在 duration_secs 内持续读取，计算实时速度
async fn run_download_speedtest(
    app_handle: tauri::AppHandle,
    request_id: &str,
    url: &str,
    duration_secs: u32,
    cancel_flag: Arc<AtomicBool>,
) -> Result<(f64, f64), String> {
    use futures_util::StreamExt;
    use reqwest::Client;

    let client = Client::builder()
        .timeout(Duration::from_secs((duration_secs + 15) as u64))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

    emit_progress(&app_handle, request_id, 0.0, "connecting", 0.0);

    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status()));
    }

    emit_progress(&app_handle, request_id, 5.0, "downloading", 0.0);

    let mut stream = response.bytes_stream();
    let mut total_bytes: u64 = 0;
    let start = Instant::now();
    let deadline = start + Duration::from_secs(duration_secs as u64);
    let mut last_report = start;

    while start.elapsed() < Duration::from_secs(duration_secs as u64)
        && !cancel_flag.load(Ordering::SeqCst)
    {
        match tokio::time::timeout(Duration::from_secs(5), stream.next()).await {
            Ok(Some(Ok(chunk))) => {
                total_bytes += chunk.len() as u64;
                let now = Instant::now();
                if now - last_report >= SPEEDTEST_REPORT_INTERVAL {
                    last_report = now;
                    let elapsed_secs = start.elapsed().as_secs_f64();
                    let speed = if elapsed_secs > 0.0 {
                        (total_bytes as f64 * 8.0) / elapsed_secs / 1_000_000.0
                    } else {
                        0.0
                    };
                    let progress = 5.0 + (elapsed_secs / duration_secs as f64) * 90.0;
                    emit_progress(&app_handle, request_id, progress.min(95.0), "downloading", speed);
                }
                if Instant::now() >= deadline {
                    break;
                }
            }
            Ok(Some(Err(e))) => {
                warn!("[relay] 下载读取错误: {}", e);
                break;
            }
            Ok(None) => break,
            Err(_) => break, // 单次读取超时
        }
    }

    let elapsed = start.elapsed().as_secs_f64();
    let speed_mbps = if elapsed > 0.0 {
        (total_bytes as f64 * 8.0) / elapsed / 1_000_000.0
    } else {
        0.0
    };

    emit_progress(&app_handle, request_id, 100.0, "completed", speed_mbps);
    Ok((speed_mbps, 0.0))
}

/// 上传测速：POST url，持续上传数据
///
/// 使用 futures_util::stream 构造分块流，通过 reqwest::Body::wrap_stream 上传。
/// 避免引入 async-stream 和 bytes 额外依赖。
async fn run_upload_speedtest(
    app_handle: tauri::AppHandle,
    request_id: &str,
    url: &str,
    duration_secs: u32,
    cancel_flag: Arc<AtomicBool>,
) -> Result<(f64, f64), String> {
    use futures_util::stream;
    use reqwest::Client;

    let client = Client::builder()
        .timeout(Duration::from_secs((duration_secs + 15) as u64))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

    emit_progress(&app_handle, request_id, 0.0, "connecting", 0.0);

    // 生成 64KB 的测试数据块
    let chunk = vec![0u8; SPEEDTEST_CHUNK_SIZE];
    let total_bytes = Arc::new(std::sync::atomic::AtomicU64::new(0));
    let start = Instant::now();

    // 构造分块流：在 duration_secs 内持续产生数据块
    let app_handle_clone = app_handle.clone();
    let request_id_owned = request_id.to_string();
    let cancel_clone = cancel_flag.clone();
    let total_bytes_clone = total_bytes.clone();
    let chunk_clone = chunk.clone();

    let upload_stream = stream::unfold((), move |()| {
        let chunk = chunk_clone.clone();
        let app_handle = app_handle_clone.clone();
        let request_id = request_id_owned.clone();
        let cancel = cancel_clone.clone();
        let total = total_bytes_clone.clone();

        async move {
            if cancel.load(Ordering::SeqCst) {
                return None;
            }
            if start.elapsed() >= Duration::from_secs(duration_secs as u64) {
                return None;
            }

            total.fetch_add(chunk.len() as u64, Ordering::SeqCst);

            let elapsed_secs = start.elapsed().as_secs_f64();
            let current_total = total.load(Ordering::SeqCst);
            let speed = if elapsed_secs > 0.0 {
                (current_total as f64 * 8.0) / elapsed_secs / 1_000_000.0
            } else {
                0.0
            };
            let progress = 5.0 + (elapsed_secs / duration_secs as f64) * 90.0;
            emit_progress(&app_handle, &request_id, progress.min(95.0), "uploading", speed);

            // 短暂让出控制权，避免阻塞
            tokio::time::sleep(Duration::from_millis(10)).await;

            Some((Ok::<_, std::io::Error>(chunk), ()))
        }
    });

    let body = reqwest::Body::wrap_stream(upload_stream);
    let response = client
        .post(url)
        .body(body)
        .send()
        .await
        .map_err(|e| format!("上传请求失败: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status()));
    }

    let final_bytes = total_bytes.load(Ordering::SeqCst);
    let elapsed_secs = start.elapsed().as_secs_f64();
    let speed_mbps = if elapsed_secs > 0.0 {
        (final_bytes as f64 * 8.0) / elapsed_secs / 1_000_000.0
    } else {
        0.0
    };

    emit_progress(&app_handle, request_id, 100.0, "completed", speed_mbps);
    Ok((0.0, speed_mbps))
}

// ===== delete_my_data（桌面端不支持）=====

#[tauri::command]
pub async fn relay_delete_my_data() -> Result<serde_json::Value, String> {
    // 桌面客户端不支持删除多租户数据，返回 NOT_SUPPORTED
    // Daemon 才需要实现此命令
    Err("NOT_SUPPORTED: 桌面客户端不支持删除设备数据".to_string())
}
