// 本地测速服务器模块（合并 file_server + tcp_speed）
// 安全防护：
// - file_server: HTTP 请求校验 Host header 必须为 127.0.0.1/localhost，防御 DNS rebinding
// - tcp_speed_server: 裸 TCP 协议（非 HTTP），浏览器 fetch 无法发送 SPEEDTEST 命令，天然免疫 DNS rebinding

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream, ToSocketAddrs};
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};
use log::{error, info, warn};
use once_cell::sync::Lazy;
use tokio::sync::Mutex;

// ===== 文件服务器（HTTP，用于文件下载测速）=====

static FILE_SERVER_PORT: Lazy<Arc<AtomicU16>> = Lazy::new(|| Arc::new(AtomicU16::new(0)));
static FILE_SERVER_RUNNING: Lazy<Arc<AtomicU16>> = Lazy::new(|| Arc::new(AtomicU16::new(0)));
static FILE_SERVER_HANDLE: Lazy<Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>> =
    Lazy::new(|| Arc::new(Mutex::new(None)));

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

    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("Failed to bind port: {}", e))?;

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
    mut stream: TcpStream,
    test_data: &[u8],
    running: Arc<AtomicBool>,
) -> Result<(), std::io::Error> {
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    stream.set_write_timeout(Some(Duration::from_secs(60)))?;

    let mut buffer = [0u8; 1024];

    loop {
        if !running.load(Ordering::SeqCst) {
            break;
        }

        match stream.read(&mut buffer) {
            Ok(0) => break,
            Ok(n) => {
                let request = String::from_utf8_lossy(&buffer[..n]);
                if request.starts_with("SPEEDTEST") {
                    let parts: Vec<&str> = request.split_whitespace().collect();
                    let size_mb: usize = if parts.len() > 1 {
                        parts[1].parse().unwrap_or(10)
                    } else {
                        10
                    };

                    info!("Sending {} MB for speed test", size_mb);
                    let total_bytes = size_mb * 1024 * 1024;
                    let mut sent = 0usize;

                    while sent < total_bytes && running.load(Ordering::SeqCst) {
                        let to_send = std::cmp::min(test_data.len(), total_bytes - sent);
                        stream.write_all(&test_data[..to_send])?;
                        sent += to_send;
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
                    Err(e) => {
                        Ok(e.kind() == std::io::ErrorKind::TimedOut
                            || e.kind() == std::io::ErrorKind::WouldBlock)
                    }
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
    pub error: Option<String>,
}

#[tauri::command]
pub async fn tcp_speed_test(
    host: String,
    port: u16,
    size_mb: Option<usize>,
) -> Result<SpeedTestResult, String> {
    let size_mb = size_mb.unwrap_or(10);
    info!("Starting TCP speed test to {}:{} for {} MB", host, port, size_mb);

    if host.is_empty() || port == 0 {
        return Ok(SpeedTestResult {
            success: false,
            speed_mbps: 0.0,
            total_bytes: 0,
            duration_ms: 0,
            error: Some(if host.is_empty() { "Host is empty".into() } else { "Port is 0".into() }),
        });
    }

    tokio::task::spawn_blocking(move || {
        let start = Instant::now();
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
                    error: Some(format!("Invalid address format '{}': {}", addr_str, e)),
                });
            }
        };

        let mut stream = match TcpStream::connect_timeout(&socket_addr, Duration::from_secs(10)) {
            Ok(s) => s,
            Err(e) => {
                return Ok(SpeedTestResult {
                    success: false,
                    speed_mbps: 0.0,
                    total_bytes: 0,
                    duration_ms: 0,
                    error: Some(format!("Failed to connect: {}", e)),
                });
            }
        };

        if let Err(e) = tune_socket(&stream) {
            warn!("Tune client socket failed: {}", e);
        }
        let _ = stream.set_read_timeout(Some(Duration::from_secs(60)));

        let request = format!("SPEEDTEST {}\n", size_mb);
        if let Err(e) = stream.write_all(request.as_bytes()) {
            return Ok(SpeedTestResult {
                success: false,
                speed_mbps: 0.0,
                total_bytes: 0,
                duration_ms: 0,
                error: Some(format!("Failed to send request: {}", e)),
            });
        }

        let mut received = 0u64;
        let mut buffer = vec![0u8; CLIENT_READ_BUF_SIZE];

        loop {
            match stream.read(&mut buffer) {
                Ok(0) => break,
                Ok(n) => received += n as u64,
                Err(e) => {
                    if e.kind() != std::io::ErrorKind::WouldBlock {
                        break;
                    }
                }
            }
        }

        let duration = start.elapsed();
        let duration_secs = duration.as_secs_f64();
        let speed_mbps = if duration_secs > 0.0 {
            (received as f64 * 8.0) / duration_secs / 1_000_000.0
        } else {
            0.0
        };

        info!(
            "TCP speed test completed: {} bytes in {:.2}s = {:.2} Mbps",
            received, duration_secs, speed_mbps
        );

        Ok(SpeedTestResult {
            success: received > 0,
            speed_mbps,
            total_bytes: received,
            duration_ms: duration.as_millis() as u64,
            error: None,
        })
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}
