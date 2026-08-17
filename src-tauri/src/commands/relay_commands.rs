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

use log::{info, warn};
use regex::Regex;
use std::net::{IpAddr, TcpStream, ToSocketAddrs};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
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
        return PingStat {
            rtts: vec![],
            min: None,
            avg: None,
            max: None,
            loss,
        };
    }
    let min = rtts.iter().cloned().fold(f64::INFINITY, f64::min);
    let max = rtts.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    let avg = rtts.iter().sum::<f64>() / rtts.len() as f64;
    PingStat {
        rtts,
        min: Some(min),
        avg: Some(avg),
        max: Some(max),
        loss,
    }
}

#[tauri::command]
pub async fn relay_dispatch_rpc(
    app_handle: tauri::AppHandle,
    command: String,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    info!("[relay] dispatch_rpc: command={}", command);
    match command.as_str() {
        "ping" => {
            let p: PingParams =
                serde_json::from_value(params).map_err(|e| format!("参数解析失败: {}", e))?;
            let result = relay_ping_inner(p.host, p.count).await?;
            serde_json::to_value(result).map_err(|e| format!("序列化失败: {}", e))
        }
        "tcping" => {
            let p: TcpingParams =
                serde_json::from_value(params).map_err(|e| format!("参数解析失败: {}", e))?;
            let result = relay_tcping_inner(p.host, p.port, p.count, p.timeout_secs).await?;
            serde_json::to_value(result).map_err(|e| format!("序列化失败: {}", e))
        }
        "node_latency" => {
            let p: NodeLatencyParams =
                serde_json::from_value(params).map_err(|e| format!("参数解析失败: {}", e))?;
            let result = relay_node_latency_inner(p.node, p.port, p.count).await?;
            serde_json::to_value(result).map_err(|e| format!("序列化失败: {}", e))
        }
        "speedtest" => {
            let p: SpeedtestParams =
                serde_json::from_value(params).map_err(|e| format!("参数解析失败: {}", e))?;
            let result = relay_speedtest_inner(
                app_handle,
                p.request_id,
                p.url,
                p.direction,
                p.duration_secs,
                p.threads,
            )
            .await?;
            serde_json::to_value(result).map_err(|e| format!("序列化失败: {}", e))
        }
        "delete_my_data" => Err("NOT_SUPPORTED: 桌面客户端不支持删除设备数据".to_string()),
        other => Err(format!("未知命令: {}", other)),
    }
}

// ===== 内部参数结构（反序列化用，不暴露为 Tauri 命令）=====

#[derive(serde::Deserialize)]
struct PingParams {
    host: String,
    count: Option<u32>,
}

#[derive(serde::Deserialize)]
struct TcpingParams {
    host: String,
    port: u16,
    count: Option<u32>,
    timeout_secs: Option<u64>,
}

#[derive(serde::Deserialize)]
struct NodeLatencyParams {
    node: String,
    port: u16,
    count: Option<u32>,
}

#[derive(serde::Deserialize)]
struct SpeedtestParams {
    request_id: String,
    url: String,
    direction: String,
    duration_secs: Option<u32>,
    threads: Option<u32>,
}

// ===== ping 实现 =====

async fn relay_ping_inner(host: String, count: Option<u32>) -> Result<PingStat, String> {
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

async fn relay_tcping_inner(
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

async fn relay_node_latency_inner(
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

    Ok(NodeLatencyResult {
        ping: ping_stat,
        tcping: tcping_stat,
    })
}

// ===== speedtest 带宽测试 =====

const SPEEDTEST_PROGRESS_EVENT: &str = "relay-speedtest-progress";
const SPEEDTEST_CHUNK_SIZE: usize = 64 * 1024;
const SPEEDTEST_REPORT_INTERVAL: Duration = Duration::from_millis(200);

/// SSRF 防护：校验 URL 是否安全
///
/// 拒绝以下情况：
/// - 非 HTTP/HTTPS scheme
/// - 主机解析到内网地址（RFC1918）、回环地址、链路本地地址
/// - 云元数据 IP（169.254.169.254）
/// - 主机名为 IP 字面量且属于上述禁止范围
fn validate_speedtest_url(url: &str) -> Result<(), String> {
    let parsed = url::Url::parse(url).map_err(|e| format!("URL 解析失败: {}", e))?;

    // 仅允许 HTTP/HTTPS
    match parsed.scheme() {
        "http" | "https" => {}
        other => return Err(format!("不支持的协议: {}（仅允许 http/https）", other)),
    }

    let host = parsed.host_str().ok_or("URL 缺少主机名")?;

    // 如果是 IP 字面量，直接校验
    if let Ok(ip) = host.parse::<IpAddr>() {
        if is_blocked_ip(&ip) {
            return Err(format!(
                "目标地址 {} 不允许访问（内网/回环/链路本地地址）",
                ip
            ));
        }
        return Ok(());
    }

    // 域名：解析后检查所有 IP 地址
    let port = parsed.port_or_known_default().unwrap_or(80);
    let addr_str = format!("{}:{}", host, port);
    let addrs = addr_str
        .to_socket_addrs()
        .map_err(|e| format!("域名解析失败: {}", e))?;

    for addr in addrs {
        let ip = addr.ip();
        if is_blocked_ip(&ip) {
            return Err(format!(
                "域名 {} 解析到禁止地址 {}（内网/回环/链路本地）",
                host, ip
            ));
        }
    }

    Ok(())
}

/// 判断 IP 是否属于禁止访问的范围
fn is_blocked_ip(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            v4.is_loopback()           // 127.0.0.0/8
                || v4.is_private()      // 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
                || v4.is_link_local()   // 169.254.0.0/16（含云元数据 169.254.169.254）
                || v4.is_unspecified()  // 0.0.0.0
                || v4.is_broadcast() // 255.255.255.255
        }
        IpAddr::V6(v6) => {
            v6.is_loopback()           // ::1
                || v6.is_unspecified()  // ::
                || (v6.segments()[0] & 0xfe00) == 0xfc00  // ULA fc00::/7
                || (v6.segments()[0] & 0xffc0) == 0xfe80 // 链路本地 fe80::/10
        }
    }
}

async fn relay_speedtest_inner(
    app_handle: tauri::AppHandle,
    request_id: String,
    url: String,
    direction: String,
    duration_secs: Option<u32>,
    threads: Option<u32>,
) -> Result<SpeedtestResult, String> {
    let duration_secs = duration_secs.unwrap_or(10).min(60);
    let _threads = threads.unwrap_or(4).max(1).min(16);

    // SSRF 防护：校验 URL 安全性
    if let Err(e) = validate_speedtest_url(&url) {
        warn!("[relay] speedtest URL 被拒绝: {}", e);
        return Ok(SpeedtestResult {
            success: false,
            download_speed_mbps: 0.0,
            upload_speed_mbps: 0.0,
            latency_ms: None,
            jitter_ms: None,
            error: Some(e),
        });
    }

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
            run_download_speedtest(
                app_handle.clone(),
                &request_id,
                &url,
                duration_secs,
                cancel_flag.clone(),
            )
            .await
        }
        "upload" => {
            run_upload_speedtest(
                app_handle.clone(),
                &request_id,
                &url,
                duration_secs,
                cancel_flag.clone(),
            )
            .await
        }
        _ => Err(format!(
            "不支持的方向: {}（可选 download/upload/both）",
            direction
        )),
    };

    timeout_handle.abort();

    match result {
        Ok((download_mbps, upload_mbps)) => Ok(SpeedtestResult {
            success: true,
            download_speed_mbps: download_mbps,
            upload_speed_mbps: upload_mbps,
            latency_ms: None,
            jitter_ms: None,
            error: None,
        }),
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
                    emit_progress(
                        &app_handle,
                        request_id,
                        progress.min(95.0),
                        "downloading",
                        speed,
                    );
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
            emit_progress(
                &app_handle,
                &request_id,
                progress.min(95.0),
                "uploading",
                speed,
            );

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

// ===== delete_my_data（桌面端不支持，已在 dispatch_rpc 中直接返回 NOT_SUPPORTED）=====
