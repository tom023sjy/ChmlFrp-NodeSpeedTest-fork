// 本地测速服务器模块（合并 file_server + tcp_speed）
// 安全防护：
// - file_server: HTTP 请求校验 Host header 必须为 127.0.0.1/localhost，防御 DNS rebinding
// - tcp_speed_server: 裸 TCP 协议（非 HTTP），浏览器 fetch 无法发送 SPEEDTEST 命令，天然免疫 DNS rebinding

use log::{error, info, warn};
use once_cell::sync::Lazy;
use std::collections::HashSet;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Shutdown, SocketAddr, TcpListener, TcpStream, ToSocketAddrs};
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

// ===== 文件服务器（HTTP，用于文件下载测速）=====

static FILE_SERVER_PORT: Lazy<Arc<AtomicU16>> = Lazy::new(|| Arc::new(AtomicU16::new(0)));
static FILE_SERVER_RUNNING: Lazy<Arc<AtomicU16>> = Lazy::new(|| Arc::new(AtomicU16::new(0)));
static FILE_SERVER_HANDLE: Lazy<Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>> =
    Lazy::new(|| Arc::new(Mutex::new(None)));
static CANCELLED_TEST_RUNS: Lazy<std::sync::Mutex<HashSet<String>>> =
    Lazy::new(|| std::sync::Mutex::new(HashSet::new()));

const TEST_FILE_SIZE: usize = 10 * 1024 * 1024;

/// 校验 HTTP Host header，防御 DNS rebinding 攻击。
/// 浏览器 DNS rebinding 时 Host 会是攻击者域名，而非 127.0.0.1/localhost。
/// Host 缺失时返回 false（拒绝），仅明确为 127.0.0.1/localhost 时放行。
fn is_valid_host(host_header: &str) -> bool {
    // 去掉端口部分
    let host = host_header.split(':').next().unwrap_or("").trim();
    host == "127.0.0.1" || host == "localhost"
}

fn generate_test_file() -> Vec<u8> {
    let mut data = Vec::with_capacity(TEST_FILE_SIZE);
    for i in 0..TEST_FILE_SIZE {
        data.push((i % 256) as u8);
    }
    data
}

#[tauri::command]
pub async fn start_file_server() -> Result<u16, String> {
    if FILE_SERVER_RUNNING.load(Ordering::SeqCst) == 1 {
        return Ok(FILE_SERVER_PORT.load(Ordering::SeqCst));
    }

    let test_data = Arc::new(generate_test_file());

    let listener = std::net::TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("Failed to bind port: {}", e))?;

    let port = listener
        .local_addr()
        .map_err(|e| format!("Failed to get local address: {}", e))?
        .port();

    FILE_SERVER_PORT.store(port, Ordering::SeqCst);
    FILE_SERVER_RUNNING.store(1, Ordering::SeqCst);

    listener
        .set_nonblocking(true)
        .map_err(|e| format!("Failed to set nonblocking: {}", e))?;

    let running = Arc::new(AtomicU16::new(1));
    let running_clone = running.clone();
    let test_data_clone = test_data.clone();

    let handle = tokio::spawn(async move {
        let listener = tokio::net::TcpListener::from_std(listener).unwrap();

        loop {
            if running_clone.load(Ordering::SeqCst) == 0 {
                break;
            }

            if let Ok((mut stream, _)) = listener.accept().await {
                let data = test_data_clone.clone();
                tokio::spawn(async move {
                    use tokio::io::{AsyncReadExt, AsyncWriteExt};

                    let mut buffer = [0u8; 1024];
                    if let Ok(n) = stream.read(&mut buffer).await {
                        if n > 0 {
                            let request = String::from_utf8_lossy(&buffer[..n]);

                            // DNS rebinding 防护：校验 Host header
                            let host_valid = request
                                .lines()
                                .find_map(|line| {
                                    let line = line.trim();
                                    line.to_ascii_lowercase()
                                        .strip_prefix("host:")
                                        .map(|h| is_valid_host(h))
                                })
                                .unwrap_or(false); // 无 Host header 时拒绝

                            if !host_valid {
                                let response =
                                    "HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n";
                                let _ = stream.write_all(response.as_bytes()).await;
                                return;
                            }

                            if request.starts_with("GET /test") {
                                let response = format!(
                                    "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                                    data.len()
                                );
                                let _ = stream.write_all(response.as_bytes()).await;
                                let _ = stream.write_all(&data).await;
                            } else {
                                let response =
                                    "HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n";
                                let _ = stream.write_all(response.as_bytes()).await;
                            }
                        }
                    }
                });
            }
        }
    });

    *FILE_SERVER_HANDLE.lock().await = Some(handle);
    Ok(port)
}

#[tauri::command]
pub async fn stop_file_server() -> Result<(), String> {
    FILE_SERVER_RUNNING.store(0, Ordering::SeqCst);
    if let Some(handle) = FILE_SERVER_HANDLE.lock().await.take() {
        handle.abort();
    }
    FILE_SERVER_PORT.store(0, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub fn get_file_server_port() -> u16 {
    FILE_SERVER_PORT.load(Ordering::SeqCst)
}

#[tauri::command]
pub fn is_file_server_running() -> bool {
    FILE_SERVER_RUNNING.load(Ordering::SeqCst) == 1
}

// ===== TCP 测速服务器（裸 TCP 协议）=====

static TCP_SPEED_SERVER_RUNNING: AtomicBool = AtomicBool::new(false);
static TCP_SPEED_SERVER_PORT: AtomicU16 = AtomicU16::new(0);

const TEST_DATA_SIZE: usize = 1024 * 1024;
const SOCKET_BUF_SIZE: usize = 2 * 1024 * 1024;
const CLIENT_READ_BUF_SIZE: usize = 256 * 1024;
const ACCEPT_POLL_INTERVAL: Duration = Duration::from_millis(10);
const FIRST_PACKET_TIMEOUT: Duration = Duration::from_secs(3);

fn parse_speed_request(request: &str) -> Result<Duration, String> {
    let mut parts = request.split_whitespace();
    match (parts.next(), parts.next(), parts.next()) {
        (Some("SPEEDTEST_TIME"), Some(value), None) => {
            let duration_ms = value
                .parse::<u64>()
                .map_err(|_| "无效的测速时长".to_string())?;
            if !(5_000..=120_000).contains(&duration_ms) {
                return Err("测速时长必须在 5000 到 120000 毫秒之间".to_string());
            }
            Ok(Duration::from_millis(duration_ms))
        }
        _ => Err("不支持的测速命令".to_string()),
    }
}

/// 调优 socket：禁用 Nagle 算法并增大收发缓冲区
fn tune_socket(stream: &TcpStream) -> Result<(), std::io::Error> {
    stream.set_nodelay(true)?;
    let sock = socket2::SockRef::from(stream);
    let _ = sock.set_recv_buffer_size(SOCKET_BUF_SIZE);
    let _ = sock.set_send_buffer_size(SOCKET_BUF_SIZE);
    Ok(())
}

#[tauri::command]
pub async fn start_tcp_speed_server() -> Result<u16, String> {
    if TCP_SPEED_SERVER_RUNNING.load(Ordering::SeqCst) {
        return Ok(TCP_SPEED_SERVER_PORT.load(Ordering::SeqCst));
    }

    let listener =
        TcpListener::bind("127.0.0.1:0").map_err(|e| format!("Failed to bind port: {}", e))?;

    let port = listener
        .local_addr()
        .map_err(|e| format!("Failed to get local address: {}", e))?
        .port();

    listener
        .set_nonblocking(true)
        .map_err(|e| format!("Failed to set nonblocking: {}", e))?;

    TCP_SPEED_SERVER_PORT.store(port, Ordering::SeqCst);
    TCP_SPEED_SERVER_RUNNING.store(true, Ordering::SeqCst);

    let running = Arc::new(AtomicBool::new(true));
    let running_clone = running.clone();

    thread::spawn(move || {
        let test_data = vec![0u8; TEST_DATA_SIZE];

        while TCP_SPEED_SERVER_RUNNING.load(Ordering::SeqCst) {
            match listener.accept() {
                Ok((stream, addr)) => {
                    info!("TCP speed server accepted connection from {}", addr);
                    if let Err(e) = tune_socket(&stream) {
                        warn!("Tune server socket failed: {}", e);
                    }
                    let test_data = test_data.clone();
                    let running = running_clone.clone();
                    thread::spawn(move || {
                        if let Err(e) = handle_tcp_client(stream, &test_data, running) {
                            error!("Client handler error: {}", e);
                        }
                    });
                }
                Err(e) => {
                    if e.kind() == std::io::ErrorKind::WouldBlock {
                        thread::sleep(ACCEPT_POLL_INTERVAL);
                    } else {
                        warn!("Accept error: {}", e);
                    }
                }
            }
        }
        info!("TCP speed server thread exiting");
    });

    info!("TCP speed server started on port {}", port);
    Ok(port)
}

fn handle_tcp_client(
    stream: TcpStream,
    test_data: &[u8],
    running: Arc<AtomicBool>,
) -> Result<(), std::io::Error> {
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    stream.set_write_timeout(Some(Duration::from_secs(60)))?;

    let mut writer = stream.try_clone()?;
    let mut reader = BufReader::new(stream);

    loop {
        if !running.load(Ordering::SeqCst) {
            break;
        }

        let mut request = String::new();
        match reader.read_line(&mut request) {
            Ok(0) => break,
            Ok(_) => {
                if request.starts_with("PING ") {
                    let sequence = request.split_whitespace().nth(1).unwrap_or("0");
                    writer.write_all(format!("PONG {}\n", sequence).as_bytes())?;
                    writer.flush()?;
                } else if request.starts_with("SPEEDTEST_TIME ") {
                    match parse_speed_request(&request) {
                        Ok(duration) => {
                            writer.set_write_timeout(Some(Duration::from_millis(100)))?;
                            let deadline = Instant::now() + duration;
                            while Instant::now() < deadline && running.load(Ordering::SeqCst) {
                                match writer.write(test_data) {
                                    Ok(0) => break,
                                    Ok(_) => {}
                                    Err(error)
                                        if error.kind() == std::io::ErrorKind::WouldBlock
                                            || error.kind() == std::io::ErrorKind::TimedOut => {}
                                    Err(error) => return Err(error),
                                }
                            }
                            let _ = writer.shutdown(Shutdown::Both);
                        }
                        Err(error) => warn!("Invalid speed test request: {}", error),
                    }
                    break;
                }
            }
            Err(e) => {
                if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::TimedOut
                {
                    continue;
                }
                break;
            }
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn check_tcp_speed_server(port: u16) -> Result<bool, String> {
    info!("Checking TCP speed server on port {}", port);
    let result = tokio::task::spawn_blocking(move || -> Result<bool, String> {
        let socket_addr = format!("127.0.0.1:{}", port)
            .parse::<std::net::SocketAddr>()
            .map_err(|e: std::net::AddrParseError| format!("地址解析失败: {}", e))?;

        match TcpStream::connect_timeout(&socket_addr, Duration::from_secs(3)) {
            Ok(mut stream) => {
                stream
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .map_err(|e| format!("设置读超时失败: {}", e))?;
                stream
                    .set_write_timeout(Some(Duration::from_secs(3)))
                    .map_err(|e| format!("设置写超时失败: {}", e))?;

                if let Err(e) = stream.write_all(b"PING\n") {
                    info!("TCP server check write failed: {}", e);
                    return Ok(false);
                }

                let mut buf = [0u8; 64];
                match stream.read(&mut buf) {
                    Ok(_) => Ok(true),
                    Err(e) => Ok(e.kind() == std::io::ErrorKind::TimedOut
                        || e.kind() == std::io::ErrorKind::WouldBlock),
                }
            }
            Err(_) => Ok(false),
        }
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))??;

    info!("TCP speed server check result: {}", result);
    Ok(result)
}

#[tauri::command]
pub async fn stop_tcp_speed_server() -> Result<(), String> {
    TCP_SPEED_SERVER_RUNNING.store(false, Ordering::SeqCst);
    TCP_SPEED_SERVER_PORT.store(0, Ordering::SeqCst);
    info!("TCP speed server stopped");
    Ok(())
}

#[derive(serde::Serialize)]
pub struct SpeedTestResult {
    pub success: bool,
    pub speed_mbps: f64,
    pub total_bytes: u64,
    pub duration_ms: u64,
    pub speed_samples: Vec<SpeedSample>,
    pub error: Option<String>,
}

#[derive(serde::Serialize)]
pub struct SpeedSample {
    pub second: usize,
    pub bytes: u64,
    pub duration_ms: u64,
    pub mbps: f64,
}

fn run_speed_test<F>(
    socket_addr: SocketAddr,
    duration: Duration,
    connect_timeout: Duration,
    read_poll_interval: Duration,
    cancelled: &F,
) -> Result<SpeedTestResult, String>
where
    F: Fn() -> bool,
{
    let mut stream = TcpStream::connect_timeout(&socket_addr, connect_timeout)
        .map_err(|error| format!("Failed to connect: {}", error))?;
    if let Err(error) = tune_socket(&stream) {
        warn!("Tune client socket failed: {}", error);
    }
    stream.set_read_timeout(Some(read_poll_interval)).ok();
    stream.set_write_timeout(Some(connect_timeout)).ok();

    let request = format!("SPEEDTEST_TIME {}\n", duration.as_millis());
    stream
        .write_all(request.as_bytes())
        .map_err(|error| format!("Failed to send request: {}", error))?;

    let waiting_since = Instant::now();
    let mut received = 0u64;
    let mut buffer = vec![0u8; CLIENT_READ_BUF_SIZE];
    let mut transfer_start: Option<Instant> = None;
    let mut sample_started_at: Option<Instant> = None;
    let mut sample_bytes = 0u64;
    let mut speed_samples = Vec::new();

    loop {
        if cancelled() {
            let _ = stream.shutdown(Shutdown::Both);
            return Err("测速已强制停止".to_string());
        }
        if transfer_start.is_none() && waiting_since.elapsed() >= FIRST_PACKET_TIMEOUT {
            let _ = stream.shutdown(Shutdown::Both);
            return Err("测速连接未返回数据".to_string());
        }
        if transfer_start.is_some_and(|started| started.elapsed() >= duration) {
            let _ = stream.shutdown(Shutdown::Both);
            break;
        }

        match stream.read(&mut buffer) {
            Ok(0) if transfer_start.is_none() => return Err("测速连接未返回数据".to_string()),
            Ok(0) => break,
            Ok(count) => {
                let now = Instant::now();
                let first = *transfer_start.get_or_insert(now);
                let window_start = *sample_started_at.get_or_insert(first);
                received += count as u64;
                sample_bytes += count as u64;
                let window = now.duration_since(window_start);
                if window >= Duration::from_secs(1) {
                    speed_samples.push(SpeedSample {
                        second: speed_samples.len() + 1,
                        bytes: sample_bytes,
                        duration_ms: window.as_millis() as u64,
                        mbps: calculate_speed(sample_bytes, window),
                    });
                    sample_started_at = Some(now);
                    sample_bytes = 0;
                }
            }
            Err(error)
                if error.kind() == std::io::ErrorKind::WouldBlock
                    || error.kind() == std::io::ErrorKind::TimedOut => {}
            Err(_) if transfer_start.is_none() => {
                let _ = stream.shutdown(Shutdown::Both);
                return Err("测速连接未返回数据".to_string());
            }
            Err(error) => return Err(format!("读取数据失败: {}", error)),
        }
    }

    let elapsed = transfer_start
        .map(|started| started.elapsed())
        .unwrap_or_default();
    if sample_bytes > 0 {
        let window = sample_started_at
            .map(|started| started.elapsed())
            .unwrap_or_default();
        speed_samples.push(SpeedSample {
            second: speed_samples.len() + 1,
            bytes: sample_bytes,
            duration_ms: window.as_millis() as u64,
            mbps: calculate_speed(sample_bytes, window),
        });
    }
    let ended_early = elapsed + Duration::from_millis(250) < duration;
    Ok(SpeedTestResult {
        success: received > 0 && !ended_early,
        speed_mbps: calculate_speed(received, elapsed),
        total_bytes: received,
        duration_ms: elapsed.as_millis() as u64,
        speed_samples,
        error: ended_early.then(|| "测速连接在目标时长前结束".to_string()),
    })
}

#[tauri::command]
pub async fn tcp_speed_test(
    host: String,
    port: u16,
    duration_seconds: u64,
    run_id: Option<String>,
) -> Result<SpeedTestResult, String> {
    let duration_seconds = duration_seconds.clamp(5, 120);
    let run_id = run_id.unwrap_or_default();
    info!(
        "Starting TCP speed test to {}:{} for {} seconds",
        host, port, duration_seconds
    );

    if host.is_empty() || port == 0 {
        return Ok(SpeedTestResult {
            success: false,
            speed_mbps: 0.0,
            total_bytes: 0,
            duration_ms: 0,
            speed_samples: Vec::new(),
            error: Some(if host.is_empty() {
                "Host is empty".into()
            } else {
                "Port is 0".into()
            }),
        });
    }

    tokio::task::spawn_blocking(move || {
        let addr_str = format!("{}:{}", host, port);

        let socket_addr = match addr_str.to_socket_addrs() {
            Ok(mut addrs) => match addrs.next() {
                Some(addr) => addr,
                None => {
                    return Ok(SpeedTestResult {
                        success: false,
                        speed_mbps: 0.0,
                        total_bytes: 0,
                        duration_ms: 0,
                        speed_samples: Vec::new(),
                        error: Some(format!("Failed to resolve address: {}", addr_str)),
                    });
                }
            },
            Err(e) => {
                return Ok(SpeedTestResult {
                    success: false,
                    speed_mbps: 0.0,
                    total_bytes: 0,
                    duration_ms: 0,
                    speed_samples: Vec::new(),
                    error: Some(format!("Invalid address format '{}': {}", addr_str, e)),
                });
            }
        };

        let result = run_speed_test(
            socket_addr,
            Duration::from_secs(duration_seconds),
            Duration::from_secs(10),
            Duration::from_millis(200),
            &|| is_test_cancelled(&run_id),
        );
        finish_test_run(&run_id);
        result
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[cfg(test)]
mod tunnel_latency_tests {
    use super::{
        calculate_latency_stats, parse_speed_request, run_speed_test, FIRST_PACKET_TIMEOUT,
    };
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;
    use std::thread;
    use std::time::{Duration, Instant};

    #[test]
    fn parses_duration_speed_request() {
        assert_eq!(
            parse_speed_request("SPEEDTEST_TIME 15000\n").unwrap(),
            Duration::from_secs(15)
        );
    }

    #[test]
    fn rejects_duration_outside_supported_range() {
        assert!(parse_speed_request("SPEEDTEST_TIME 4999\n").is_err());
        assert!(parse_speed_request("SPEEDTEST_TIME 120001\n").is_err());
    }

    #[test]
    fn first_packet_timeout_is_three_seconds() {
        assert_eq!(FIRST_PACKET_TIMEOUT, Duration::from_secs(3));
    }

    #[test]
    fn duration_protocol_stops_at_deadline_without_waiting_for_eof() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut stream = BufReader::new(stream);
            let mut command = String::new();
            stream.read_line(&mut command).unwrap();
            assert!(command.starts_with("SPEEDTEST_TIME "));
            let payload = vec![0u8; 64 * 1024];
            while stream.get_mut().write_all(&payload).is_ok() {}
        });

        let started = Instant::now();
        let result = run_speed_test(
            address,
            Duration::from_millis(150),
            Duration::from_secs(1),
            Duration::from_millis(50),
            &|| false,
        )
        .unwrap();
        server.join().unwrap();

        assert!(result.success);
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn calculates_full_tunnel_latency_stats() {
        let result = calculate_latency_stats(&[Some(10.0), Some(14.0), None, Some(12.0)]).unwrap();
        assert_eq!(result.avg_ms, 12.0);
        assert_eq!(result.jitter_ms, 3.0);
        assert_eq!(result.loss_percent, 25.0);
        assert_eq!(result.received, 3);
    }

    #[test]
    fn rejects_all_lost_probes() {
        assert!(calculate_latency_stats(&[None, None]).is_err());
    }

    #[tokio::test]
    async fn measures_rtt_through_the_test_protocol() {
        let port = super::start_tcp_speed_server().await.unwrap();
        let result = super::tunnel_latency_test(
            "127.0.0.1".to_string(),
            port,
            Some(4),
            Some(1000),
            Some("test-run".to_string()),
        )
        .await
        .unwrap();
        super::stop_tcp_speed_server().await.unwrap();
        assert!(result.success);
        assert_eq!(result.sent, 4);
        assert_eq!(result.received, 4);
        assert_eq!(result.loss_percent, 0.0);
    }
}

fn calculate_speed(bytes: u64, duration: Duration) -> f64 {
    let seconds = duration.as_secs_f64();
    if seconds <= 0.0 {
        0.0
    } else {
        bytes as f64 * 8.0 / seconds / 1_000_000.0
    }
}

fn is_test_cancelled(run_id: &str) -> bool {
    CANCELLED_TEST_RUNS
        .lock()
        .map(|runs| runs.contains(run_id))
        .unwrap_or(true)
}

fn finish_test_run(run_id: &str) {
    if let Ok(mut runs) = CANCELLED_TEST_RUNS.lock() {
        runs.remove(run_id);
    }
}

#[tauri::command]
pub async fn cancel_full_chain_test(run_id: String) -> Result<(), String> {
    CANCELLED_TEST_RUNS
        .lock()
        .map_err(|e| format!("获取测速取消状态失败: {}", e))?
        .insert(run_id);
    Ok(())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelLatencyResult {
    pub success: bool,
    pub avg_ms: f64,
    pub jitter_ms: f64,
    pub loss_percent: f64,
    pub sent: usize,
    pub received: usize,
    pub rtts: Vec<Option<f64>>,
    pub error: Option<String>,
}

fn calculate_latency_stats(samples: &[Option<f64>]) -> Result<TunnelLatencyResult, String> {
    let rtts: Vec<f64> = samples.iter().filter_map(|sample| *sample).collect();
    if rtts.is_empty() {
        return Err("全链路探测全部超时".to_string());
    }
    let avg_ms = rtts.iter().sum::<f64>() / rtts.len() as f64;
    let jitter_ms = if rtts.len() > 1 {
        rtts.windows(2)
            .map(|pair| (pair[1] - pair[0]).abs())
            .sum::<f64>()
            / (rtts.len() - 1) as f64
    } else {
        0.0
    };
    Ok(TunnelLatencyResult {
        success: true,
        avg_ms,
        jitter_ms,
        loss_percent: (samples.len() - rtts.len()) as f64 / samples.len() as f64 * 100.0,
        sent: samples.len(),
        received: rtts.len(),
        rtts: samples.to_vec(),
        error: None,
    })
}

#[tauri::command]
pub async fn tunnel_latency_test(
    host: String,
    port: u16,
    count: Option<usize>,
    timeout_ms: Option<u64>,
    run_id: Option<String>,
) -> Result<TunnelLatencyResult, String> {
    let count = count.unwrap_or(4).clamp(1, 20);
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(3000).clamp(100, 30000));
    let run_id = run_id.unwrap_or_default();
    tokio::task::spawn_blocking(move || {
        let addr = format!("{}:{}", host, port)
            .to_socket_addrs()
            .map_err(|e| format!("解析隧道地址失败: {}", e))?
            .next()
            .ok_or_else(|| "无法解析隧道地址".to_string())?;
        let mut stream = TcpStream::connect_timeout(&addr, timeout)
            .map_err(|e| format!("连接隧道失败: {}", e))?;
        stream
            .set_read_timeout(Some(Duration::from_millis(200)))
            .ok();
        stream.set_write_timeout(Some(timeout)).ok();
        stream.set_nodelay(true).ok();
        let mut reader = BufReader::new(stream.try_clone().map_err(|e| e.to_string())?);
        let mut samples = Vec::with_capacity(count);
        for sequence in 0..count {
            if is_test_cancelled(&run_id) {
                finish_test_run(&run_id);
                return Err("测速已强制停止".to_string());
            }
            let started = Instant::now();
            if stream
                .write_all(format!("PING {}\n", sequence).as_bytes())
                .is_err()
                || stream.flush().is_err()
            {
                samples.push(None);
                continue;
            }
            let mut response = String::new();
            loop {
                if is_test_cancelled(&run_id) {
                    finish_test_run(&run_id);
                    return Err("测速已强制停止".to_string());
                }
                match reader.read_line(&mut response) {
                    Ok(n) if n > 0 && response.trim() == format!("PONG {}", sequence) => {
                        samples.push(Some(started.elapsed().as_secs_f64() * 1000.0));
                        break;
                    }
                    Err(ref e)
                        if (e.kind() == std::io::ErrorKind::WouldBlock
                            || e.kind() == std::io::ErrorKind::TimedOut)
                            && started.elapsed() < timeout =>
                    {
                        continue
                    }
                    _ => {
                        samples.push(None);
                        break;
                    }
                }
            }
            thread::sleep(Duration::from_millis(100));
        }
        finish_test_run(&run_id);
        calculate_latency_stats(&samples)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}
