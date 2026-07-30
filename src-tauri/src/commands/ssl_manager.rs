// ChmlFrp SSL 证书自动申请模块
// 通过 cf-v2.uapis.cn/ssl/* API 实现，使用 DNS-01 验证
// 支持 ChmlFrp 免费域名（用 accessToken）和自有域名（用 DNS 凭证自动添加 TXT 记录）
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::Duration;
use tauri::{Emitter, Manager};

use super::dns_config::{self, UserTokenState};
use super::dns_provider::{self, DnsCredential, DnsProviderKind};
use crate::utils::get_app_data_dir;

const SSL_API_BASE: &str = "https://cf-v2.uapis.cn";

/// ChmlFrp 免费域名凭证的特殊标识（与 DDNS/DNS 容灾模块保持一致）
const CHMLFRP_CREDENTIAL_ID: &str = "__chmlfrp__";

/// SSL 证书验证 TXT 记录的备注文案（写入 DNS 服务商的备注字段，提示用户勿删）
const SSL_TXT_RECORD_REMARKS: &str = "ChmlFrp-SSL证书申请验证，请勿删除";

/// SSL 证书申请记录（列表/详情通用）
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SslCertificate {
    pub id: i64,
    pub provider: String,
    pub domains: String,
    #[serde(default)]
    pub challenge_type: Option<String>,
    pub status: String,
    pub created_at: String,
    #[serde(default)]
    pub updated_at: Option<String>,
    #[serde(default)]
    pub issued_at: Option<String>,
    #[serde(default)]
    pub expires_at: Option<String>,
    // 详情额外字段
    #[serde(default)]
    pub challenge_token: Option<String>,
    #[serde(default)]
    pub challenge_key_authorization: Option<String>,
    #[serde(default)]
    pub error_message: Option<String>,
    #[serde(default)]
    pub instructions: Option<String>,
    #[serde(default)]
    pub dns_record_name: Option<String>,
    #[serde(default)]
    pub dns_record_value: Option<String>,
}

/// 申请证书的请求参数
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SslRequestParams {
    /// 证书颁发机构：letsencrypt / zerossl
    pub provider: String,
    /// 申请域名列表
    pub domains: Vec<String>,
    /// 验证方式：dns01
    pub challenge_type: String,
    /// DNS 凭证 ID（用于自动添加 TXT 记录），ChmlFrp 免费域名用 "__chmlfrp__"
    pub credential_id: String,
}

/// 自动申请结果
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SslAutoRequestResult {
    /// 申请 ID
    pub id: i64,
    /// 最终状态：issued / pending / failed
    pub final_status: String,
    /// 证书详情
    pub certificate: SslCertificate,
    /// 过程日志
    pub logs: Vec<String>,
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .user_agent("ChmlFrpCommunityToolbox/1.3")
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))
}

/// 获取当前登录用户的 accessToken
fn get_access_token(app_handle: &tauri::AppHandle) -> Result<String, String> {
    let state = app_handle
        .try_state::<UserTokenState>()
        .ok_or_else(|| "未找到用户登录状态".to_string())?;
    let guard = state.0.lock().map_err(|e| format!("锁错误: {}", e))?;
    guard
        .clone()
        .ok_or_else(|| "未登录或登录已过期，请先登录".to_string())
}

/// 构造带鉴权的请求构建器（Authorization: Bearer + query token）
fn authed_request(
    client: &reqwest::Client,
    method: reqwest::Method,
    path: &str,
    access_token: &str,
) -> reqwest::RequestBuilder {
    let url = format!("{}{}", SSL_API_BASE, path);
    client
        .request(method, &url)
        .header("Authorization", format!("Bearer {}", access_token))
        .query(&[("token", access_token)])
}

/// 解析 SSL API 响应（统一结构 {msg, code, data, state}）
fn parse_ssl_response(body: &str) -> Result<serde_json::Value, String> {
    let value: serde_json::Value = serde_json::from_str(body)
        .map_err(|e| format!("解析响应失败: {} (body: {})", e, body))?;
    let code = value.get("code").and_then(|c| c.as_i64()).unwrap_or(0);
    if code != 200 {
        let msg = value.get("msg").and_then(|m| m.as_str()).unwrap_or("未知错误");
        return Err(format!("SSL API 错误: {} - {}", code, msg));
    }
    Ok(value)
}

/// 查找 DNS 凭证（支持 ChmlFrp 特殊标识）
fn find_credential(
    app_handle: &tauri::AppHandle,
    credential_id: &str,
    owner_username: &str,
) -> Result<DnsCredential, String> {
    if credential_id == CHMLFRP_CREDENTIAL_ID {
        let access_token = get_access_token(app_handle)?;
        return Ok(DnsCredential {
            id: String::new(),
            name: String::new(),
            provider: DnsProviderKind::Chmlfrp,
            secret_id: String::new(),
            secret_key: String::new(),
            token: access_token,
            api_token: String::new(),
            owner_username: String::new(),
        });
    }
    let all = dns_config::list_all_credentials(app_handle)?;
    all.into_iter()
        .find(|c| {
            c.id == credential_id
                && (c.owner_username.is_empty() || c.owner_username == owner_username)
        })
        .ok_or_else(|| format!("未找到凭证: {}", credential_id))
}

/// 从 dnsRecordName 和申请域名列表中拆分出主域名和子域名
/// 例如 dnsRecordName="_acme-challenge.ddzz.cn.", domains=["ddzz.cn","ddzz.com"]
/// 返回 ("ddzz.cn", "_acme-challenge")
fn split_dns_record(
    dns_record_name: &str,
    domains: &[String],
) -> Result<(String, String), String> {
    // 去掉末尾的点
    let name = dns_record_name.trim_end_matches('.');
    // 在 domains 中找到被包含的主域名（按长度降序匹配，优先匹配更长的域名）
    let mut sorted_domains = domains.to_vec();
    sorted_domains.sort_by(|a, b| b.len().cmp(&a.len()));
    for domain in &sorted_domains {
        let domain_trimmed = domain.trim_end_matches('.');
        let suffix = format!(".{}", domain_trimmed);
        if name == domain_trimmed {
            return Ok((domain_trimmed.to_string(), "@".to_string()));
        }
        if name.ends_with(&suffix) {
            let subdomain = &name[..name.len() - suffix.len()];
            return Ok((domain_trimmed.to_string(), subdomain.to_string()));
        }
    }
    Err(format!(
        "无法从 DNS 记录名 {} 中匹配到申请域名 {:?}",
        dns_record_name, domains
    ))
}

// ===== Tauri 命令 =====

/// 获取 SSL 证书列表
#[tauri::command]
pub async fn ssl_list(app_handle: tauri::AppHandle) -> Result<Vec<SslCertificate>, String> {
    let access_token = get_access_token(&app_handle)?;
    let client = http_client()?;
    let resp = authed_request(&client, reqwest::Method::GET, "/ssl/list", &access_token)
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| format!("读取响应失败: {}", e))?;
    if !status.is_success() {
        return Err(format!("HTTP {}: {}", status, body));
    }
    let value = parse_ssl_response(&body)?;
    let certs = value
        .get("data")
        .and_then(|d| d.get("certificates"))
        .cloned()
        .unwrap_or_default();
    serde_json::from_value(certs).map_err(|e| format!("解析证书列表失败: {}", e))
}

/// 获取 SSL 证书详情
#[tauri::command]
pub async fn ssl_detail(
    app_handle: tauri::AppHandle,
    id: i64,
) -> Result<SslCertificate, String> {
    let access_token = get_access_token(&app_handle)?;
    let client = http_client()?;
    let resp = authed_request(
        &client,
        reqwest::Method::GET,
        &format!("/ssl/detail/{}", id),
        &access_token,
    )
    .send()
    .await
    .map_err(|e| format!("请求失败: {}", e))?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| format!("读取响应失败: {}", e))?;
    if !status.is_success() {
        return Err(format!("HTTP {}: {}", status, body));
    }
    let value = parse_ssl_response(&body)?;
    let data = value.get("data").cloned().unwrap_or_default();
    serde_json::from_value(data).map_err(|e| format!("解析证书详情失败: {}", e))
}

/// 申请 SSL 证书（仅创建申请，不自动验证）
#[tauri::command]
pub async fn ssl_request(
    app_handle: tauri::AppHandle,
    params: SslRequestParams,
) -> Result<SslCertificate, String> {
    let access_token = get_access_token(&app_handle)?;
    let client = http_client()?;
    let payload = serde_json::json!({
        "provider": params.provider,
        "domains": params.domains,
        "challengeType": params.challenge_type,
    });
    let resp = authed_request(&client, reqwest::Method::POST, "/ssl/request", &access_token)
        .header("Content-Type", "application/json")
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| format!("读取响应失败: {}", e))?;
    if !status.is_success() {
        return Err(format!("HTTP {}: {}", status, body));
    }
    let value = parse_ssl_response(&body)?;
    let data = value.get("data").cloned().unwrap_or_default();
    serde_json::from_value(data).map_err(|e| format!("解析申请结果失败: {}", e))
}

/// 触发域名验证
#[tauri::command]
pub async fn ssl_verify(
    app_handle: tauri::AppHandle,
    id: i64,
) -> Result<SslCertificate, String> {
    let access_token = get_access_token(&app_handle)?;
    let client = http_client()?;
    let resp = authed_request(
        &client,
        reqwest::Method::POST,
        &format!("/ssl/verify/{}", id),
        &access_token,
    )
    .header("Content-Type", "application/json")
        .json(&serde_json::json!({}))
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| format!("读取响应失败: {}", e))?;
    // verify 接口可能返回 524 超时，此时返回提示让前端轮询
    if status.as_u16() == 524 {
        return Err("验证请求超时，请稍后查询证书状态确认结果".to_string());
    }
    if !status.is_success() {
        return Err(format!("HTTP {}: {}", status, body));
    }
    let value = parse_ssl_response(&body)?;
    let data = value.get("data").cloned().unwrap_or_default();
    serde_json::from_value(data).map_err(|e| format!("解析验证结果失败: {}", e))
}

/// 删除 SSL 证书
#[tauri::command]
pub async fn ssl_delete(
    app_handle: tauri::AppHandle,
    id: i64,
) -> Result<(), String> {
    let access_token = get_access_token(&app_handle)?;
    let client = http_client()?;
    let resp = authed_request(
        &client,
        reqwest::Method::DELETE,
        &format!("/ssl/delete/{}", id),
        &access_token,
    )
    .send()
    .await
    .map_err(|e| format!("请求失败: {}", e))?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| format!("读取响应失败: {}", e))?;
    if !status.is_success() {
        return Err(format!("HTTP {}: {}", status, body));
    }
    // 删除接口仅返回 msg/code/state，无 data 字段，校验 code 即可
    parse_ssl_response(&body)?;
    Ok(())
}

/// 自动申请 SSL 证书（一键完成：申请 → 添加 TXT → 验证 → 轮询）
#[tauri::command]
pub async fn ssl_auto_request(
    app_handle: tauri::AppHandle,
    username: String,
    params: SslRequestParams,
) -> Result<SslAutoRequestResult, String> {
    let mut logs = Vec::new();
    let access_token = get_access_token(&app_handle)?;
    let client = http_client()?;

    // 1. 创建证书申请
    logs.push(format!("正在向 {} 申请证书...", params.provider));
    let payload = serde_json::json!({
        "provider": params.provider,
        "domains": params.domains,
        "challengeType": params.challenge_type,
    });
    let resp = authed_request(&client, reqwest::Method::POST, "/ssl/request", &access_token)
        .header("Content-Type", "application/json")
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("申请请求失败: {}", e))?;
    let body = resp.text().await.map_err(|e| format!("读取响应失败: {}", e))?;
    let value = parse_ssl_response(&body)?;
    let cert: SslCertificate = serde_json::from_value(value.get("data").cloned().unwrap_or_default())
        .map_err(|e| format!("解析申请结果失败: {}", e))?;
    logs.push(format!("申请已创建，ID: {}，状态: {}", cert.id, cert.status));

    let dns_record_name = cert.dns_record_name.as_deref().ok_or_else(|| {
        "申请成功但未返回 DNS 记录名，无法自动验证".to_string()
    })?;
    let dns_record_value = cert.dns_record_value.as_deref().ok_or_else(|| {
        "申请成功但未返回 DNS 记录值，无法自动验证".to_string()
    })?;

    // 2. 用 DNS 凭证添加 TXT 记录（备注标注用途，提示用户勿删）
    logs.push(format!("正在添加 TXT 记录: {} = {}", dns_record_name, dns_record_value));
    let cred = find_credential(&app_handle, &params.credential_id, &username)?;
    let (domain, subdomain) = split_dns_record(dns_record_name, &params.domains)?;
    logs.push(format!("拆分结果: 主域名={}, 子域名={}", domain, subdomain));
    dns_provider::upsert_record_with_remarks(&cred, &domain, &subdomain, "TXT", dns_record_value, SSL_TXT_RECORD_REMARKS)
        .await
        .map_err(|e| {
            format!("添加 TXT 记录失败: {}（可手动添加后重实验证）", e)
        })?;
    logs.push(format!("TXT 记录添加成功（备注：{}）", SSL_TXT_RECORD_REMARKS));

    // 3. 等待 DNS 传播（10 秒）
    logs.push("等待 DNS 记录传播（10 秒）...".to_string());
    tokio::time::sleep(Duration::from_secs(10)).await;

    // 4. 触发验证
    logs.push("正在触发域名验证...".to_string());
    let verify_resp = authed_request(
        &client,
        reqwest::Method::POST,
        &format!("/ssl/verify/{}", cert.id),
        &access_token,
    )
    .header("Content-Type", "application/json")
    .json(&serde_json::json!({}))
    .send()
    .await;
    match verify_resp {
        Ok(r) => {
            let status = r.status();
            let _ = r.text().await;
            if status.as_u16() == 524 {
                logs.push("验证请求超时（524），将继续轮询状态".to_string());
            } else if !status.is_success() {
                logs.push(format!("验证请求返回 HTTP {}，将继续轮询状态", status));
            } else {
                logs.push("验证请求已发送".to_string());
            }
        }
        Err(e) => {
            logs.push(format!("验证请求失败: {}，将继续轮询状态", e));
        }
    }

    // 5. 轮询证书详情（最多 120 秒，每 5 秒一次）
    logs.push("开始轮询证书状态...".to_string());
    let poll_client = http_client()?;
    let mut final_cert = cert.clone();
    let max_attempts = 24;
    for attempt in 1..=max_attempts {
        tokio::time::sleep(Duration::from_secs(5)).await;
        let detail_resp = authed_request(
            &poll_client,
            reqwest::Method::GET,
            &format!("/ssl/detail/{}", cert.id),
            &access_token,
        )
        .send()
        .await;
        match detail_resp {
            Ok(r) => {
                let status = r.status();
                let body = r.text().await.unwrap_or_default();
                if status.is_success() {
                    if let Ok(value) = parse_ssl_response(&body) {
                        if let Ok(c) = serde_json::from_value::<SslCertificate>(
                            value.get("data").cloned().unwrap_or_default(),
                        ) {
                            final_cert = c.clone();
                            if final_cert.status == "issued" {
                                logs.push(format!(
                                    "第 {} 次轮询：证书已签发！",
                                    attempt
                                ));
                                break;
                            }
                            if let Some(err) = &final_cert.error_message {
                                if !err.is_empty() {
                                    logs.push(format!(
                                        "第 {} 次轮询：验证失败 - {}",
                                        attempt, err
                                    ));
                                    break;
                                }
                            }
                            logs.push(format!(
                                "第 {} 次轮询：状态仍为 {}",
                                attempt, final_cert.status
                            ));
                        }
                    }
                }
            }
            Err(e) => {
                logs.push(format!("第 {} 次轮询失败: {}", attempt, e));
            }
        }
    }

    let final_status = final_cert.status.clone();
    if final_status == "issued" {
        logs.push("证书申请成功！".to_string());
    } else {
        logs.push(format!("轮询结束，最终状态: {}", final_status));
    }

    Ok(SslAutoRequestResult {
        id: final_cert.id,
        final_status,
        certificate: final_cert,
        logs,
    })
}

// ===== 后台异步申请（不阻塞前端）=====

/// 申请进度事件 payload（通过 `ssl-request-progress` 事件推送给前端）
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SslRequestProgress {
    /// 本次申请的随机任务 ID（前端用于关联进度事件）
    pub task_id: String,
    /// 关联的证书申请 ID（申请创建成功后才有值）
    pub cert_id: Option<i64>,
    /// 当前阶段：requesting / adding_txt / waiting_dns / verifying / polling / done / error
    pub stage: String,
    /// 一条人类可读日志
    pub message: String,
    /// 是否为最终消息（done / error）
    pub is_final: bool,
    /// 最终证书状态（仅 done 阶段有值）
    pub final_status: Option<String>,
}

/// 异步申请 SSL 证书（后台执行，立即返回任务 ID）
/// 进度通过 `ssl-request-progress` 事件推送到前端
#[tauri::command]
pub async fn ssl_auto_request_async(
    app_handle: tauri::AppHandle,
    username: String,
    params: SslRequestParams,
) -> Result<String, String> {
    let task_id = format!("ssl-{}", chrono::Utc::now().timestamp_millis());
    let handle = app_handle.clone();
    let task_id_clone = task_id.clone();

    tauri::async_runtime::spawn(async move {
        let emit = |stage: &str, message: String, cert_id: Option<i64>, is_final: bool, final_status: Option<String>| {
            let _ = handle.emit(
                "ssl-request-progress",
                SslRequestProgress {
                    task_id: task_id_clone.clone(),
                    stage: stage.to_string(),
                    message,
                    cert_id,
                    is_final,
                    final_status,
                },
            );
        };

        let access_token = match get_access_token(&handle) {
            Ok(t) => t,
            Err(e) => {
                emit("error", format!("获取登录状态失败: {}", e), None, true, None);
                return;
            }
        };
        let client = match http_client() {
            Ok(c) => c,
            Err(e) => {
                emit("error", format!("创建 HTTP 客户端失败: {}", e), None, true, None);
                return;
            }
        };

        // 1. 创建证书申请
        emit("requesting", format!("正在向 {} 申请证书...", params.provider), None, false, None);
        let payload = serde_json::json!({
            "provider": params.provider,
            "domains": params.domains,
            "challengeType": params.challenge_type,
        });
        let resp = match authed_request(&client, reqwest::Method::POST, "/ssl/request", &access_token)
            .header("Content-Type", "application/json")
            .json(&payload)
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) => {
                emit("error", format!("申请请求失败: {}", e), None, true, None);
                return;
            }
        };
        let body = match resp.text().await {
            Ok(b) => b,
            Err(e) => {
                emit("error", format!("读取响应失败: {}", e), None, true, None);
                return;
            }
        };
        let value = match parse_ssl_response(&body) {
            Ok(v) => v,
            Err(e) => {
                emit("error", format!("解析申请响应失败: {}", e), None, true, None);
                return;
            }
        };
        let cert: SslCertificate = match serde_json::from_value(value.get("data").cloned().unwrap_or_default()) {
            Ok(c) => c,
            Err(e) => {
                emit("error", format!("解析申请结果失败: {}", e), None, true, None);
                return;
            }
        };
        emit("requesting", format!("申请已创建，ID: {}，状态: {}", cert.id, cert.status), Some(cert.id), false, None);

        let dns_record_name = match cert.dns_record_name.as_deref() {
            Some(n) => n,
            None => {
                emit("error", "申请成功但未返回 DNS 记录名，无法自动验证".to_string(), Some(cert.id), true, None);
                return;
            }
        };
        let dns_record_value = match cert.dns_record_value.as_deref() {
            Some(v) => v,
            None => {
                emit("error", "申请成功但未返回 DNS 记录值，无法自动验证".to_string(), Some(cert.id), true, None);
                return;
            }
        };

        // 2. 添加 TXT 记录
        emit("adding_txt", format!("正在添加 TXT 记录: {}", dns_record_name), Some(cert.id), false, None);
        let cred = match find_credential(&handle, &params.credential_id, &username) {
            Ok(c) => c,
            Err(e) => {
                emit("error", format!("获取 DNS 凭证失败: {}", e), Some(cert.id), true, None);
                return;
            }
        };
        let (domain, subdomain) = match split_dns_record(dns_record_name, &params.domains) {
            Ok(d) => d,
            Err(e) => {
                emit("error", format!("拆分 DNS 记录失败: {}", e), Some(cert.id), true, None);
                return;
            }
        };
        if let Err(e) = dns_provider::upsert_record_with_remarks(&cred, &domain, &subdomain, "TXT", dns_record_value, SSL_TXT_RECORD_REMARKS).await {
            emit("error", format!("添加 TXT 记录失败: {}", e), Some(cert.id), true, None);
            return;
        }
        emit("adding_txt", format!("TXT 记录添加成功（备注：{}）", SSL_TXT_RECORD_REMARKS), Some(cert.id), false, None);

        // 3. 等待 DNS 传播
        emit("waiting_dns", "等待 DNS 记录传播（10 秒）...".to_string(), Some(cert.id), false, None);
        tokio::time::sleep(Duration::from_secs(10)).await;

        // 4. 触发验证
        emit("verifying", "正在触发域名验证...".to_string(), Some(cert.id), false, None);
        let verify_resp = authed_request(
            &client,
            reqwest::Method::POST,
            &format!("/ssl/verify/{}", cert.id),
            &access_token,
        )
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({}))
        .send()
        .await;
        match verify_resp {
            Ok(r) => {
                let status = r.status();
                let _ = r.text().await;
                if status.as_u16() == 524 {
                    emit("verifying", "验证请求超时（524），将继续轮询状态".to_string(), Some(cert.id), false, None);
                } else if !status.is_success() {
                    emit("verifying", format!("验证请求返回 HTTP {}，将继续轮询", status), Some(cert.id), false, None);
                } else {
                    emit("verifying", "验证请求已发送".to_string(), Some(cert.id), false, None);
                }
            }
            Err(e) => {
                emit("verifying", format!("验证请求失败: {}，将继续轮询", e), Some(cert.id), false, None);
            }
        }

        // 5. 轮询证书详情
        emit("polling", "开始轮询证书状态...".to_string(), Some(cert.id), false, None);
        let poll_client = match http_client() {
            Ok(c) => c,
            Err(e) => {
                emit("error", format!("创建轮询客户端失败: {}", e), Some(cert.id), true, None);
                return;
            }
        };
        let mut final_status = cert.status.clone();
        let max_attempts = 24;
        for attempt in 1..=max_attempts {
            tokio::time::sleep(Duration::from_secs(5)).await;
            let detail_resp = authed_request(
                &poll_client,
                reqwest::Method::GET,
                &format!("/ssl/detail/{}", cert.id),
                &access_token,
            )
            .send()
            .await;
            match detail_resp {
                Ok(r) => {
                    let status = r.status();
                    let body = r.text().await.unwrap_or_default();
                    if status.is_success() {
                        if let Ok(value) = parse_ssl_response(&body) {
                            if let Ok(c) = serde_json::from_value::<SslCertificate>(
                                value.get("data").cloned().unwrap_or_default(),
                            ) {
                                final_status = c.status.clone();
                                if c.status == "issued" {
                                    emit("polling", format!("第 {} 次轮询：证书已签发！", attempt), Some(cert.id), false, None);
                                    break;
                                }
                                if let Some(err) = &c.error_message {
                                    if !err.is_empty() {
                                        emit("polling", format!("第 {} 次轮询：验证失败 - {}", attempt, err), Some(cert.id), false, None);
                                        break;
                                    }
                                }
                                emit("polling", format!("第 {} 次轮询：状态 {}", attempt, c.status), Some(cert.id), false, None);
                            }
                        }
                    }
                }
                Err(e) => {
                    emit("polling", format!("第 {} 次轮询失败: {}", attempt, e), Some(cert.id), false, None);
                }
            }
        }

        if final_status == "issued" {
            emit("done", "证书申请成功！".to_string(), Some(cert.id), true, Some(final_status));
        } else {
            emit("done", format!("轮询结束，最终状态: {}", final_status), Some(cert.id), true, Some(final_status.clone()));
        }
    });

    Ok(task_id)
}

// ===== SSL 申请日志持久化（按账号隔离）=====

const SSL_LOGS_FILE: &str = "ssl-logs.json";

/// 一条历史申请日志
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SslRequestLog {
    /// 唯一 ID（与 task_id 一致）
    pub id: String,
    /// 申请的域名（逗号分隔）
    pub domains: String,
    /// 证书颁发机构
    pub provider: String,
    /// 最终状态：issued / pending / failed
    pub final_status: String,
    /// 详细日志（每行一条）
    pub logs: Vec<String>,
    /// 创建时间（本地时间，ISO 8601）
    pub created_at: String,
    /// 完成时间（本地时间，ISO 8601）
    pub finished_at: String,
    /// 所属用户名（账号隔离）
    #[serde(default)]
    pub owner_username: String,
}

fn ssl_logs_path(app_handle: &tauri::AppHandle) -> Result<PathBuf, String> {
    let base = get_app_data_dir(app_handle)?;
    let dir = base.join("ssl");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建 SSL 日志目录失败: {}", e))?;
    Ok(dir.join(SSL_LOGS_FILE))
}

fn read_logs_json(path: &PathBuf) -> Vec<SslRequestLog> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_logs_json(path: &PathBuf, data: &Vec<SslRequestLog>) -> Result<(), String> {
    let content = serde_json::to_string_pretty(data).map_err(|e| format!("序列化失败: {}", e))?;
    std::fs::write(path, content).map_err(|e| format!("写入文件失败: {}", e))
}

/// 保存一条申请日志（前端在申请完成时调用）
#[tauri::command]
pub async fn ssl_save_log(
    app_handle: tauri::AppHandle,
    log: SslRequestLog,
) -> Result<(), String> {
    let path = ssl_logs_path(&app_handle)?;
    let mut list = read_logs_json(&path);
    // 同 ID 覆盖
    list.retain(|l| l.id != log.id);
    list.push(log);
    // 按完成时间倒序（新的在前）
    list.sort_by(|a, b| b.finished_at.cmp(&a.finished_at));
    // 限制最多保留 200 条，避免无限增长
    if list.len() > 200 {
        list.truncate(200);
    }
    write_logs_json(&path, &list)
}

/// 列出当前用户的所有申请日志
#[tauri::command]
pub async fn ssl_list_logs(
    app_handle: tauri::AppHandle,
    username: String,
) -> Result<Vec<SslRequestLog>, String> {
    let path = ssl_logs_path(&app_handle)?;
    let list = read_logs_json(&path);
    // 账号隔离：owner_username 为空（旧数据）或等于当前用户可见
    Ok(list
        .into_iter()
        .filter(|l| l.owner_username.is_empty() || l.owner_username == username)
        .collect())
}

/// 清空当前用户的所有申请日志
#[tauri::command]
pub async fn ssl_clear_logs(
    app_handle: tauri::AppHandle,
    username: String,
) -> Result<(), String> {
    let path = ssl_logs_path(&app_handle)?;
    let list = read_logs_json(&path);
    // 仅保留其他用户的日志
    let remaining: Vec<SslRequestLog> = list
        .into_iter()
        .filter(|l| !l.owner_username.is_empty() && l.owner_username != username)
        .collect();
    write_logs_json(&path, &remaining)
}
