// DNS 服务商抽象与实现
// 支持 DNSPod.cn（腾讯云 API 3.0）、DNSPod.com（Token）、Aliyun（HMAC-SHA1）、Cloudflare（API Token）
// 仅暴露 list_records 与 upsert_cname 两个高层接口，供 dns_monitor 调用
use base64::Engine;
use hmac::{Hmac, Mac};
use sha1::Sha1;
use sha2::{Digest, Sha256};

type HmacSha256 = Hmac<Sha256>;
type HmacSha1 = Hmac<Sha1>;

/// DNS 服务商类型
#[derive(Clone, Copy, Debug, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DnsProviderKind {
    /// 国内腾讯云（DNSPod.cn，API 3.0 TC3-HMAC-SHA256）
    DnspodCn,
    /// 国际腾讯云（DNSPod.com，Token 鉴权）
    DnspodCom,
    /// 阿里云（HMAC-SHA1 RPC）
    Aliyun,
    /// Cloudflare（API Token）
    Cloudflare,
    /// ChmlFrp 免费域名（cf-v2.uapis.cn，用户 Token 鉴权）
    Chmlfrp,
}

/// 服务商友好名称（用于 UI 展示）
pub fn provider_label(kind: DnsProviderKind) -> &'static str {
    match kind {
        DnsProviderKind::DnspodCn => "DNSPod.cn（腾讯云）",
        DnsProviderKind::DnspodCom => "DNSPod.com（国际）",
        DnsProviderKind::Aliyun => "Aliyun（阿里云）",
        DnsProviderKind::Cloudflare => "Cloudflare",
        DnsProviderKind::Chmlfrp => "ChmlFrp 免费域名",
    }
}

/// 一组 DNS 凭证（与一个服务商一一对应）
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DnsCredential {
    /// 唯一标识
    pub id: String,
    /// 用户自定义名称
    pub name: String,
    /// 服务商类型
    pub provider: DnsProviderKind,
    /// DNSPod.cn: SecretId；Aliyun: AccessKeyId
    #[serde(default)]
    pub secret_id: String,
    /// DNSPod.cn: SecretKey；Aliyun: AccessKeySecret
    #[serde(default)]
    pub secret_key: String,
    /// DNSPod.com: 格式 "ID,Token"；ChmlFrp: 用户 Token（纯字符串）
    #[serde(default)]
    pub token: String,
    /// Cloudflare: API Token
    #[serde(default)]
    pub api_token: String,
    /// 凭证所属用户名（账号隔离用，旧数据为空时视为所有用户可见）
    #[serde(default)]
    pub owner_username: String,
}

/// DNS 记录信息（用于查询现有记录）
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DnsRecord {
    pub record_id: String,
    pub record_type: String,
    pub name: String,
    pub value: String,
    pub line: String,
}

/// 高层接口：列出主域名下指定子域名前缀的所有记录
pub async fn list_records(
    cred: &DnsCredential,
    domain: &str,
    subdomain: Option<&str>,
) -> Result<Vec<DnsRecord>, String> {
    match cred.provider {
        DnsProviderKind::DnspodCn => dnspod_cn::list_records(cred, domain, subdomain).await,
        DnsProviderKind::DnspodCom => dnspod_com::list_records(cred, domain, subdomain).await,
        DnsProviderKind::Aliyun => aliyun::list_records(cred, domain, subdomain).await,
        DnsProviderKind::Cloudflare => cloudflare::list_records(cred, domain, subdomain).await,
        DnsProviderKind::Chmlfrp => chmlfrp::list_records(cred, domain, subdomain).await,
    }
}

/// 高层接口：验证凭证是否有效（执行一次轻量级「列出域名」调用）
/// 成功返回 Ok(())，失败返回带服务商标识的错误信息
pub async fn verify_credential(cred: &DnsCredential) -> Result<(), String> {
    match cred.provider {
        DnsProviderKind::DnspodCn => dnspod_cn::verify(cred).await,
        DnsProviderKind::DnspodCom => dnspod_com::verify(cred).await,
        DnsProviderKind::Aliyun => aliyun::verify(cred).await,
        DnsProviderKind::Cloudflare => cloudflare::verify(cred).await,
        DnsProviderKind::Chmlfrp => chmlfrp::verify(cred).await,
    }
}

/// 高层接口：确保子域名指向指定 CNAME 值（不存在则创建，存在则更新）
pub async fn upsert_cname(
    cred: &DnsCredential,
    domain: &str,
    subdomain: &str,
    cname_value: &str,
) -> Result<(), String> {
    upsert_record(cred, domain, subdomain, "CNAME", cname_value).await
}

/// 高层接口：通用记录 upsert（支持 A / AAAA / CNAME）
/// 不存在则创建，存在且类型/值相同则跳过，存在但类型或值不同则更新
pub async fn upsert_record(
    cred: &DnsCredential,
    domain: &str,
    subdomain: &str,
    record_type: &str,
    value: &str,
) -> Result<(), String> {
    match cred.provider {
        DnsProviderKind::DnspodCn => dnspod_cn::upsert_record(cred, domain, subdomain, record_type, value).await,
        DnsProviderKind::DnspodCom => dnspod_com::upsert_record(cred, domain, subdomain, record_type, value).await,
        DnsProviderKind::Aliyun => aliyun::upsert_record(cred, domain, subdomain, record_type, value).await,
        DnsProviderKind::Cloudflare => cloudflare::upsert_record(cred, domain, subdomain, record_type, value).await,
        DnsProviderKind::Chmlfrp => chmlfrp::upsert_record(cred, domain, subdomain, record_type, value).await,
    }
}

/// 高层接口：带备注的通用记录 upsert（供 SSL 证书验证等需要标注用途的场景使用）
/// remarks 会在创建记录时写入备注字段；已存在记录更新时各服务商行为不同（部分不支持修改备注）
pub async fn upsert_record_with_remarks(
    cred: &DnsCredential,
    domain: &str,
    subdomain: &str,
    record_type: &str,
    value: &str,
    remarks: &str,
) -> Result<(), String> {
    match cred.provider {
        DnsProviderKind::DnspodCn => dnspod_cn::upsert_record_with_remarks(cred, domain, subdomain, record_type, value, remarks).await,
        DnsProviderKind::DnspodCom => dnspod_com::upsert_record_with_remarks(cred, domain, subdomain, record_type, value, remarks).await,
        DnsProviderKind::Aliyun => aliyun::upsert_record_with_remarks(cred, domain, subdomain, record_type, value, remarks).await,
        DnsProviderKind::Cloudflare => cloudflare::upsert_record_with_remarks(cred, domain, subdomain, record_type, value, remarks).await,
        DnsProviderKind::Chmlfrp => chmlfrp::upsert_record_with_remarks(cred, domain, subdomain, record_type, value, remarks).await,
    }
}

/// 高层接口：列出凭证下所有主域名（用于 TXT 清理扫描）
pub async fn list_domains(cred: &DnsCredential) -> Result<Vec<String>, String> {
    match cred.provider {
        DnsProviderKind::DnspodCn => dnspod_cn::list_domains(cred).await,
        DnsProviderKind::DnspodCom => dnspod_com::list_domains(cred).await,
        DnsProviderKind::Aliyun => aliyun::list_domains(cred).await,
        DnsProviderKind::Cloudflare => cloudflare::list_domains(cred).await,
        DnsProviderKind::Chmlfrp => chmlfrp::list_domains(cred).await,
    }
}

/// 高层接口：删除指定 DNS 记录（按 record_id）
pub async fn delete_record(
    cred: &DnsCredential,
    domain: &str,
    record_id: &str,
) -> Result<(), String> {
    match cred.provider {
        DnsProviderKind::DnspodCn => dnspod_cn::delete_record(cred, domain, record_id).await,
        DnsProviderKind::DnspodCom => dnspod_com::delete_record(cred, domain, record_id).await,
        DnsProviderKind::Aliyun => aliyun::delete_record(cred, domain, record_id).await,
        DnsProviderKind::Cloudflare => cloudflare::delete_record(cred, domain, record_id).await,
        DnsProviderKind::Chmlfrp => chmlfrp::delete_record(cred, domain, record_id).await,
    }
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .user_agent("ChmlFrpCommunityToolbox/1.3")
        // 不强制 no_proxy，让 reqwest 使用系统代理
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))
}

// ===== 腾讯云 DNSPod.cn（API 3.0 TC3-HMAC-SHA256）=====
mod dnspod_cn {
    use super::*;
    use chrono::Utc;

    const HOST: &str = "dnspod.tencentcloudapi.com";
    const SERVICE: &str = "dnspod";
    const VERSION: &str = "2021-03-23";

    /// 调用一次腾讯云 API
    async fn call(
        cred: &DnsCredential,
        action: &str,
        payload: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        let payload_str = serde_json::to_string(&payload).unwrap_or_default();
        let timestamp = Utc::now().timestamp();
        let date = Utc::now().format("%Y-%m-%d").to_string();

        // 1. 拼接规范请求串
        // 腾讯云规范要求 x-tc-action 的值为小写形式
        let action_lower = action.to_lowercase();
        let canonical_request = format!(
            "POST\n/\n\ncontent-type:application/json; charset=utf-8\nhost:{}\nx-tc-action:{}\n\ncontent-type;host;x-tc-action\n{}",
            HOST,
            action_lower,
            hex::encode(Sha256::digest(payload_str.as_bytes()))
        );

        // 2. 拼接签名串
        let credential_scope = format!("{}/{}/tc3_request", date, SERVICE);
        let string_to_sign = format!(
            "TC3-HMAC-SHA256\n{}\n{}\n{}",
            timestamp,
            credential_scope,
            hex::encode(Sha256::digest(canonical_request.as_bytes()))
        );

        // 3. 计算签名
        let secret_date = HmacSha256::new_from_slice(format!("TC3{}", cred.secret_key).as_bytes())
            .map_err(|e| format!("HMAC 初始化失败: {}", e))?
            .chain_update(date.as_bytes())
            .finalize()
            .into_bytes();
        let secret_service = HmacSha256::new_from_slice(&secret_date)
            .map_err(|e| format!("HMAC 初始化失败: {}", e))?
            .chain_update(SERVICE.as_bytes())
            .finalize()
            .into_bytes();
        let secret_signing = HmacSha256::new_from_slice(&secret_service)
            .map_err(|e| format!("HMAC 初始化失败: {}", e))?
            .chain_update(b"tc3_request")
            .finalize()
            .into_bytes();
        let signature = HmacSha256::new_from_slice(&secret_signing)
            .map_err(|e| format!("HMAC 初始化失败: {}", e))?
            .chain_update(string_to_sign.as_bytes())
            .finalize()
            .into_bytes();
        let signature_hex = hex::encode(signature);

        // 4. 构造 Authorization
        let authorization = format!(
            "TC3-HMAC-SHA256 Credential={}/{}, SignedHeaders=content-type;host;x-tc-action, Signature={}",
            cred.secret_id, credential_scope, signature_hex
        );

        let resp = http_client()?
            .post(format!("https://{}", HOST))
            .header("Authorization", authorization)
            .header("Content-Type", "application/json; charset=utf-8")
            .header("Host", HOST)
            .header("X-TC-Action", action)
            .header("X-TC-Version", VERSION)
            .header("X-TC-Timestamp", timestamp.to_string())
            .body(payload_str)
            .send()
            .await
            .map_err(|e| format!("DNSPod.cn 请求失败: {}", e))?;

        let status = resp.status();
        let body = resp.text().await.map_err(|e| format!("读取响应失败: {}", e))?;
        if !status.is_success() {
            return Err(format!("DNSPod.cn HTTP {}: {}", status, body));
        }

        let value: serde_json::Value = serde_json::from_str(&body)
            .map_err(|e| format!("解析响应失败: {} (body: {})", e, body))?;

        let resp_err = value.get("Response").and_then(|r| r.get("Error"));
        if let Some(err) = resp_err {
            let code = err.get("Code").and_then(|v| v.as_str()).unwrap_or("Unknown");
            let msg = err.get("Message").and_then(|v| v.as_str()).unwrap_or("");
            return Err(format!("DNSPod.cn 错误: {} - {}", code, msg));
        }
        Ok(value)
    }

    pub async fn list_records(
        cred: &DnsCredential,
        domain: &str,
        subdomain: Option<&str>,
    ) -> Result<Vec<DnsRecord>, String> {
        let mut payload = serde_json::json!({ "Domain": domain });
        if let Some(sub) = subdomain {
            payload["Subdomain"] = serde_json::Value::String(sub.to_string());
        }
        let resp = call(cred, "DescribeRecordList", payload).await?;
        let list = resp
            .get("Response")
            .and_then(|r| r.get("RecordList"))
            .and_then(|l| l.as_array())
            .cloned()
            .unwrap_or_default();

        let records = list
            .into_iter()
            .map(|item| DnsRecord {
                record_id: item.get("RecordId").and_then(|v| v.as_i64()).map(|i| i.to_string()).unwrap_or_default(),
                record_type: item.get("Type").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                name: item.get("Name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                value: item.get("Value").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                line: item.get("Line").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            })
            .collect();
        Ok(records)
    }

    /// 验证凭证：调用 DescribeDomainList 列出域名（轻量级，仅鉴权）
    pub async fn verify(cred: &DnsCredential) -> Result<(), String> {
        call(cred, "DescribeDomainList", serde_json::json!({})).await?;
        Ok(())
    }

    /// 列出凭证下所有主域名（用于 TXT 清理扫描）
    pub async fn list_domains(cred: &DnsCredential) -> Result<Vec<String>, String> {
        let v = call(cred, "DescribeDomainList", serde_json::json!({})).await?;
        let arr = v
            .get("Response")
            .and_then(|r| r.get("DomainList"))
            .and_then(|l| l.as_array())
            .ok_or("DescribeDomainList 返回格式异常")?;
        Ok(arr
            .iter()
            .filter_map(|d| d.get("Name").and_then(|n| n.as_str()).map(String::from))
            .collect())
    }

    /// 删除指定 DNS 记录（按 record_id）
    pub async fn delete_record(
        cred: &DnsCredential,
        domain: &str,
        record_id: &str,
    ) -> Result<(), String> {
        let rid: i64 = record_id
            .parse()
            .map_err(|_| format!("RecordId 解析失败: {}", record_id))?;
        let payload = serde_json::json!({
            "Domain": domain,
            "RecordId": rid,
        });
        call(cred, "DeleteRecord", payload).await?;
        Ok(())
    }

    pub async fn upsert_record(
        cred: &DnsCredential,
        domain: &str,
        subdomain: &str,
        record_type: &str,
        value: &str,
    ) -> Result<(), String> {
        let records = list_records(cred, domain, Some(subdomain)).await?;
        let existing = records.into_iter().find(|r| r.name == subdomain);

        if let Some(rec) = existing {
            if rec.record_type.eq_ignore_ascii_case(record_type) && rec.value == value {
                return Ok(());
            }
            let record_id: i64 = rec.record_id.parse().map_err(|_| "RecordId 解析失败".to_string())?;
            let payload = serde_json::json!({
                "Domain": domain,
                "RecordId": record_id,
                "SubDomain": subdomain,
                "RecordType": record_type,
                "RecordLine": "默认",
                "Value": value,
            });
            call(cred, "ModifyRecord", payload).await?;
        } else {
            let payload = serde_json::json!({
                "Domain": domain,
                "SubDomain": subdomain,
                "RecordType": record_type,
                "RecordLine": "默认",
                "Value": value,
            });
            call(cred, "CreateRecord", payload).await?;
        }
        Ok(())
    }

    /// 带备注的 upsert（CreateRecord/ModifyRecord 写入 Remark 字段）
    pub async fn upsert_record_with_remarks(
        cred: &DnsCredential,
        domain: &str,
        subdomain: &str,
        record_type: &str,
        value: &str,
        remarks: &str,
    ) -> Result<(), String> {
        let records = list_records(cred, domain, Some(subdomain)).await?;
        let existing = records.into_iter().find(|r| r.name == subdomain);

        if let Some(rec) = existing {
            if rec.record_type.eq_ignore_ascii_case(record_type) && rec.value == value {
                return Ok(());
            }
            let record_id: i64 = rec.record_id.parse().map_err(|_| "RecordId 解析失败".to_string())?;
            let payload = serde_json::json!({
                "Domain": domain,
                "RecordId": record_id,
                "SubDomain": subdomain,
                "RecordType": record_type,
                "RecordLine": "默认",
                "Value": value,
                "Remark": remarks,
            });
            call(cred, "ModifyRecord", payload).await?;
        } else {
            let payload = serde_json::json!({
                "Domain": domain,
                "SubDomain": subdomain,
                "RecordType": record_type,
                "RecordLine": "默认",
                "Value": value,
                "Remark": remarks,
            });
            call(cred, "CreateRecord", payload).await?;
        }
        Ok(())
    }
}

// ===== 国际 DNSPod.com（Token 鉴权）=====
mod dnspod_com {
    use super::*;

    const API_BASE: &str = "https://dnsapi.cn";

    async fn call(
        cred: &DnsCredential,
        path: &str,
        mut form: Vec<(&str, String)>,
    ) -> Result<serde_json::Value, String> {
        form.push(("login_token", cred.token.clone()));
        form.push(("format", "json".to_string()));

        let resp = http_client()?
            .post(format!("{}{}", API_BASE, path))
            .form(&form)
            .send()
            .await
            .map_err(|e| format!("DNSPod.com 请求失败: {}", e))?;

        let status = resp.status();
        let body = resp.text().await.map_err(|e| format!("读取响应失败: {}", e))?;
        if !status.is_success() {
            return Err(format!("DNSPod.com HTTP {}: {}", status, body));
        }

        let value: serde_json::Value = serde_json::from_str(&body)
            .map_err(|e| format!("解析响应失败: {} (body: {})", e, body))?;

        let code = value.get("status").and_then(|s| s.get("code")).and_then(|c| c.as_i64()).unwrap_or(0);
        if code != 1 {
            let msg = value.get("status").and_then(|s| s.get("message")).and_then(|m| m.as_str()).unwrap_or("");
            return Err(format!("DNSPod.com 错误: {} - {}", code, msg));
        }
        Ok(value)
    }

    pub async fn list_records(
        cred: &DnsCredential,
        domain: &str,
        subdomain: Option<&str>,
    ) -> Result<Vec<DnsRecord>, String> {
        let mut form = vec![("domain", domain.to_string())];
        if let Some(sub) = subdomain {
            form.push(("sub_domain", sub.to_string()));
        }
        let resp = call(cred, "/Record.List", form).await?;
        let list = resp.get("records").and_then(|l| l.as_array()).cloned().unwrap_or_default();
        let records = list
            .into_iter()
            .map(|item| DnsRecord {
                record_id: item.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                record_type: item.get("type").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                name: item.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                value: item.get("value").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                line: item.get("line").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            })
            .collect();
        Ok(records)
    }

    pub async fn upsert_record(
        cred: &DnsCredential,
        domain: &str,
        subdomain: &str,
        record_type: &str,
        value: &str,
    ) -> Result<(), String> {
        let records = list_records(cred, domain, Some(subdomain)).await?;
        let existing = records.into_iter().find(|r| r.name == subdomain);

        if let Some(rec) = existing {
            if rec.record_type.eq_ignore_ascii_case(record_type) && rec.value == value {
                return Ok(());
            }
            let form = vec![
                ("domain", domain.to_string()),
                ("record_id", rec.record_id),
                ("sub_domain", subdomain.to_string()),
                ("record_type", record_type.to_string()),
                ("record_line", "默认".to_string()),
                ("value", value.to_string()),
            ];
            call(cred, "/Record.Modify", form).await?;
        } else {
            let form = vec![
                ("domain", domain.to_string()),
                ("sub_domain", subdomain.to_string()),
                ("record_type", record_type.to_string()),
                ("record_line", "默认".to_string()),
                ("value", value.to_string()),
            ];
            call(cred, "/Record.Create", form).await?;
        }
        Ok(())
    }

    /// 带备注的 upsert（CreateRecord/Modify 写入 remark 字段）
    pub async fn upsert_record_with_remarks(
        cred: &DnsCredential,
        domain: &str,
        subdomain: &str,
        record_type: &str,
        value: &str,
        remarks: &str,
    ) -> Result<(), String> {
        let records = list_records(cred, domain, Some(subdomain)).await?;
        let existing = records.into_iter().find(|r| r.name == subdomain);

        if let Some(rec) = existing {
            if rec.record_type.eq_ignore_ascii_case(record_type) && rec.value == value {
                return Ok(());
            }
            let form = vec![
                ("domain", domain.to_string()),
                ("record_id", rec.record_id),
                ("sub_domain", subdomain.to_string()),
                ("record_type", record_type.to_string()),
                ("record_line", "默认".to_string()),
                ("value", value.to_string()),
                ("remark", remarks.to_string()),
            ];
            call(cred, "/Record.Modify", form).await?;
        } else {
            let form = vec![
                ("domain", domain.to_string()),
                ("sub_domain", subdomain.to_string()),
                ("record_type", record_type.to_string()),
                ("record_line", "默认".to_string()),
                ("value", value.to_string()),
                ("remark", remarks.to_string()),
            ];
            call(cred, "/Record.Create", form).await?;
        }
        Ok(())
    }

    /// 验证凭证：调用 /Domain.List 列出域名（轻量级，仅鉴权）
    pub async fn verify(cred: &DnsCredential) -> Result<(), String> {
        call(cred, "/Domain.List", vec![]).await?;
        Ok(())
    }

    /// 列出凭证下所有主域名（用于 TXT 清理扫描）
    pub async fn list_domains(cred: &DnsCredential) -> Result<Vec<String>, String> {
        let resp = call(cred, "/Domain.List", vec![]).await?;
        let arr = resp
            .get("domains")
            .and_then(|l| l.as_array())
            .ok_or("Domain.List 返回格式异常")?;
        Ok(arr
            .iter()
            .filter_map(|d| d.get("name").and_then(|n| n.as_str()).map(String::from))
            .collect())
    }

    /// 删除指定 DNS 记录（按 record_id）
    pub async fn delete_record(
        cred: &DnsCredential,
        domain: &str,
        record_id: &str,
    ) -> Result<(), String> {
        let form = vec![
            ("domain", domain.to_string()),
            ("record_id", record_id.to_string()),
        ];
        call(cred, "/Record.Remove", form).await?;
        Ok(())
    }
}

// ===== 阿里云 Aliyun（RPC + HMAC-SHA1）=====
mod aliyun {
    use super::*;
    use chrono::Utc;

    const API_BASE: &str = "https://alidns.aliyuncs.com";

    /// 计算阿里云 RPC 风格签名
    fn sign(params: &[(String, String)], secret_key: &str) -> String {
        // 按 key 字典序升序排序后拼接 canonicalized_query
        let mut sorted = params.to_vec();
        sorted.sort_by(|a, b| a.0.cmp(&b.0));
        let canonicalized: String = sorted
            .into_iter()
            .map(|(k, v)| {
                format!(
                    "{}={}",
                    percent_encode(&k),
                    percent_encode(&v)
                )
            })
            .collect::<Vec<_>>()
            .join("&");
        let string_to_sign = format!("GET&{}&{}", percent_encode("/"), percent_encode(&canonicalized));
        let mut mac = HmacSha1::new_from_slice(format!("{}&", secret_key).as_bytes())
            .expect("HMAC-SHA1 初始化失败");
        mac.update(string_to_sign.as_bytes());
        base64::engine::general_purpose::STANDARD.encode(mac.finalize().into_bytes())
    }

    fn percent_encode(s: &str) -> String {
        use percent_encoding::{utf8_percent_encode, AsciiSet, CONTROLS};
        const RESERVED: &AsciiSet = &CONTROLS
            .add(b' ').add(b'!').add(b'"').add(b'#').add(b'$').add(b'%').add(b'&').add(b'\'')
            .add(b'(').add(b')').add(b'*').add(b'+').add(b',').add(b'/').add(b':').add(b';')
            .add(b'<').add(b'=').add(b'>').add(b'?').add(b'@').add(b'[').add(b'\\').add(b']')
            .add(b'^').add(b'`').add(b'{').add(b'|').add(b'}');
        utf8_percent_encode(s, RESERVED).to_string()
    }

    async fn call(
        cred: &DnsCredential,
        action: &str,
        mut params: Vec<(String, String)>,
    ) -> Result<serde_json::Value, String> {
        params.push(("Format".to_string(), "JSON".to_string()));
        params.push(("Version".to_string(), "2015-01-09".to_string()));
        params.push(("AccessKeyId".to_string(), cred.secret_id.clone()));
        params.push(("SignatureMethod".to_string(), "HMAC-SHA1".to_string()));
        params.push(("SignatureVersion".to_string(), "1.0".to_string()));
        params.push(("SignatureNonce".to_string(), uuid_v4()));
        params.push(("Timestamp".to_string(), Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string()));
        params.push(("Action".to_string(), action.to_string()));

        let signature = sign(&params, &cred.secret_key);
        params.push(("Signature".to_string(), signature));

        let query: String = params
            .into_iter()
            .map(|(k, v)| format!("{}={}", percent_encode(&k), percent_encode(&v)))
            .collect::<Vec<_>>()
            .join("&");

        let resp = http_client()?
            .get(format!("{}?{}", API_BASE, query))
            .send()
            .await
            .map_err(|e| format!("Aliyun 请求失败: {}", e))?;

        let status = resp.status();
        let body = resp.text().await.map_err(|e| format!("读取响应失败: {}", e))?;
        if !status.is_success() {
            return Err(format!("Aliyun HTTP {}: {}", status, body));
        }

        let value: serde_json::Value = serde_json::from_str(&body)
            .map_err(|e| format!("解析响应失败: {} (body: {})", e, body))?;

        if let Some(err) = value.get("Code").and_then(|c| c.as_str()) {
            if !err.is_empty() && err != "0" {
                let msg = value.get("Message").and_then(|m| m.as_str()).unwrap_or("");
                return Err(format!("Aliyun 错误: {} - {}", err, msg));
            }
        }
        Ok(value)
    }

    fn uuid_v4() -> String {
        // 简易随机串作为 SignatureNonce
        use std::time::{SystemTime, UNIX_EPOCH};
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        format!("{:x}", nanos)
    }

    pub async fn list_records(
        cred: &DnsCredential,
        domain: &str,
        subdomain: Option<&str>,
    ) -> Result<Vec<DnsRecord>, String> {
        let mut params = vec![("DomainName".to_string(), domain.to_string())];
        if let Some(sub) = subdomain {
            let full = if sub.is_empty() { domain.to_string() } else { format!("{}.{}", sub, domain) };
            params.push(("RRKeyWord".to_string(), full));
        }
        let resp = call(cred, "DescribeDomainRecords", params).await?;
        let list = resp.get("DomainRecords").and_then(|d| d.get("Record")).and_then(|r| r.as_array()).cloned().unwrap_or_default();
        let records = list
            .into_iter()
            .map(|item| DnsRecord {
                record_id: item.get("RecordId").and_then(|v| v.as_i64()).map(|i| i.to_string()).unwrap_or_default(),
                record_type: item.get("Type").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                name: item.get("RR").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                value: item.get("Value").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                line: item.get("Line").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            })
            .collect();
        Ok(records)
    }

    pub async fn upsert_record(
        cred: &DnsCredential,
        domain: &str,
        subdomain: &str,
        record_type: &str,
        value: &str,
    ) -> Result<(), String> {
        let records = list_records(cred, domain, Some(subdomain)).await?;
        let target_full = if subdomain.is_empty() { domain.to_string() } else { format!("{}.{}", subdomain, domain) };
        let existing = records.into_iter().find(|r| {
            let full = if r.name.is_empty() { domain.to_string() } else { format!("{}.{}", r.name, domain) };
            full == target_full
        });

        if let Some(rec) = existing {
            if rec.record_type.eq_ignore_ascii_case(record_type) && rec.value == value {
                return Ok(());
            }
            let params = vec![
                ("RecordId".to_string(), rec.record_id),
                ("RR".to_string(), subdomain.to_string()),
                ("Type".to_string(), record_type.to_string()),
                ("Value".to_string(), value.to_string()),
            ];
            call(cred, "UpdateDomainRecord", params).await?;
        } else {
            let params = vec![
                ("DomainName".to_string(), domain.to_string()),
                ("RR".to_string(), subdomain.to_string()),
                ("Type".to_string(), record_type.to_string()),
                ("Value".to_string(), value.to_string()),
            ];
            call(cred, "AddDomainRecord", params).await?;
        }
        Ok(())
    }

    /// 带备注的 upsert（AddDomainRecord/UpdateDomainRecord 写入 Remark 字段）
    pub async fn upsert_record_with_remarks(
        cred: &DnsCredential,
        domain: &str,
        subdomain: &str,
        record_type: &str,
        value: &str,
        remarks: &str,
    ) -> Result<(), String> {
        let records = list_records(cred, domain, Some(subdomain)).await?;
        let target_full = if subdomain.is_empty() { domain.to_string() } else { format!("{}.{}", subdomain, domain) };
        let existing = records.into_iter().find(|r| {
            let full = if r.name.is_empty() { domain.to_string() } else { format!("{}.{}", r.name, domain) };
            full == target_full
        });

        if let Some(rec) = existing {
            if rec.record_type.eq_ignore_ascii_case(record_type) && rec.value == value {
                return Ok(());
            }
            let params = vec![
                ("RecordId".to_string(), rec.record_id),
                ("RR".to_string(), subdomain.to_string()),
                ("Type".to_string(), record_type.to_string()),
                ("Value".to_string(), value.to_string()),
                ("Remark".to_string(), remarks.to_string()),
            ];
            call(cred, "UpdateDomainRecord", params).await?;
        } else {
            let params = vec![
                ("DomainName".to_string(), domain.to_string()),
                ("RR".to_string(), subdomain.to_string()),
                ("Type".to_string(), record_type.to_string()),
                ("Value".to_string(), value.to_string()),
                ("Remark".to_string(), remarks.to_string()),
            ];
            call(cred, "AddDomainRecord", params).await?;
        }
        Ok(())
    }

    /// 验证凭证：调用 DescribeDomains 列出域名（轻量级，仅鉴权）
    pub async fn verify(cred: &DnsCredential) -> Result<(), String> {
        call(cred, "DescribeDomains", vec![]).await?;
        Ok(())
    }

    /// 列出凭证下所有主域名（用于 TXT 清理扫描）
    pub async fn list_domains(cred: &DnsCredential) -> Result<Vec<String>, String> {
        let resp = call(cred, "DescribeDomains", vec![]).await?;
        let arr = resp
            .get("Domains")
            .and_then(|d| d.get("Domain"))
            .and_then(|l| l.as_array())
            .ok_or("DescribeDomains 返回格式异常")?;
        Ok(arr
            .iter()
            .filter_map(|d| d.get("DomainName").and_then(|n| n.as_str()).map(String::from))
            .collect())
    }

    /// 删除指定 DNS 记录（按 record_id）
    pub async fn delete_record(
        cred: &DnsCredential,
        domain: &str,
        record_id: &str,
    ) -> Result<(), String> {
        let _ = domain; // aliyun DeleteDomainRecord 仅需 RecordId
        let params = vec![("RecordId".to_string(), record_id.to_string())];
        call(cred, "DeleteDomainRecord", params).await?;
        Ok(())
    }
}

// ===== Cloudflare（API Token）=====
mod cloudflare {
    use super::*;

    const API_BASE: &str = "https://api.cloudflare.com/client/v4";

    /// 获取指定域名的 Zone ID
    /// Cloudflare 按 Zone 组织域名，需先查询 Zone ID 才能操作记录
    async fn get_zone_id(cred: &DnsCredential, domain: &str) -> Result<String, String> {
        let resp = http_client()?
            .get(format!("{}/zones", API_BASE))
            .header("Authorization", format!("Bearer {}", cred.api_token))
            .query(&[("name", domain)])
            .send()
            .await
            .map_err(|e| format!("Cloudflare 查询 Zone 失败: {}", e))?;

        let status = resp.status();
        let body = resp.text().await.map_err(|e| format!("读取响应失败: {}", e))?;
        if !status.is_success() {
            return Err(format!("Cloudflare HTTP {}: {}", status, body));
        }

        let value: serde_json::Value = serde_json::from_str(&body)
            .map_err(|e| format!("解析响应失败: {} (body: {})", e, body))?;

        if !value.get("success").and_then(|v| v.as_bool()).unwrap_or(false) {
            let msg = value
                .get("errors")
                .and_then(|e| e.get(0))
                .and_then(|e| e.get("message"))
                .and_then(|m| m.as_str())
                .unwrap_or("未知错误");
            return Err(format!("Cloudflare 错误: {}", msg));
        }

        let zone_id = value
            .get("result")
            .and_then(|r| r.get(0))
            .and_then(|z| z.get("id"))
            .and_then(|i| i.as_str())
            .ok_or_else(|| format!("未找到域名 {} 的 Zone", domain))?;
        Ok(zone_id.to_string())
    }

    pub async fn list_records(
        cred: &DnsCredential,
        domain: &str,
        subdomain: Option<&str>,
    ) -> Result<Vec<DnsRecord>, String> {
        let zone_id = get_zone_id(cred, domain).await?;

        // 构造完整记录名用于过滤
        let full_name = match subdomain {
            Some(sub) if !sub.is_empty() => format!("{}.{}", sub, domain),
            _ => domain.to_string(),
        };

        let resp = http_client()?
            .get(format!("{}/zones/{}/dns_records", API_BASE, zone_id))
            .header("Authorization", format!("Bearer {}", cred.api_token))
            .query(&[("name", &full_name)])
            .send()
            .await
            .map_err(|e| format!("Cloudflare 查询记录失败: {}", e))?;

        let status = resp.status();
        let body = resp.text().await.map_err(|e| format!("读取响应失败: {}", e))?;
        if !status.is_success() {
            return Err(format!("Cloudflare HTTP {}: {}", status, body));
        }

        let value: serde_json::Value = serde_json::from_str(&body)
            .map_err(|e| format!("解析响应失败: {} (body: {})", e, body))?;

        if !value.get("success").and_then(|v| v.as_bool()).unwrap_or(false) {
            let msg = value
                .get("errors")
                .and_then(|e| e.get(0))
                .and_then(|e| e.get("message"))
                .and_then(|m| m.as_str())
                .unwrap_or("未知错误");
            return Err(format!("Cloudflare 错误: {}", msg));
        }

        let list = value.get("result").and_then(|r| r.as_array()).cloned().unwrap_or_default();
        let records = list
            .into_iter()
            .map(|item| {
                let name = item.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
                // Cloudflare 返回的 name 是完整域名（subdomain.example.com）
                // 截取为子域名前缀，便于上层统一处理
                let sub = if name == domain {
                    String::new()
                } else if name.ends_with(&format!(".{}", domain)) {
                    name[..name.len() - domain.len() - 1].to_string()
                } else {
                    name.clone()
                };
                DnsRecord {
                    record_id: item.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                    record_type: item.get("type").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                    name: sub,
                    value: item.get("content").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                    line: String::new(),
                }
            })
            .collect();
        Ok(records)
    }

    pub async fn upsert_record(
        cred: &DnsCredential,
        domain: &str,
        subdomain: &str,
        record_type: &str,
        value: &str,
    ) -> Result<(), String> {
        let zone_id = get_zone_id(cred, domain).await?;
        let records = list_records(cred, domain, Some(subdomain)).await?;
        let existing = records.into_iter().find(|r| r.name == subdomain);

        // Cloudflare 记录名（完整 FQDN）
        let record_name = if subdomain.is_empty() {
            domain.to_string()
        } else {
            format!("{}.{}", subdomain, domain)
        };

        // CNAME 记录值需以点结尾（FQDN），A/AAAA 直接使用 IP
        let normalized_value = if record_type.eq_ignore_ascii_case("CNAME") {
            if value.ends_with('.') { value.to_string() } else { format!("{}.", value) }
        } else {
            value.to_string()
        };

        if let Some(rec) = existing {
            if rec.record_type.eq_ignore_ascii_case(record_type)
                && rec.value.trim_end_matches('.') == value.trim_end_matches('.')
            {
                return Ok(());
            }
            let resp = http_client()?
                .put(format!("{}/zones/{}/dns_records/{}", API_BASE, zone_id, rec.record_id))
                .header("Authorization", format!("Bearer {}", cred.api_token))
                .json(&serde_json::json!({
                    "type": record_type,
                    "name": record_name,
                    "content": normalized_value,
                    "proxied": false,
                }))
                .send()
                .await
                .map_err(|e| format!("Cloudflare 更新记录失败: {}", e))?;

            let status = resp.status();
            let body = resp.text().await.map_err(|e| format!("读取响应失败: {}", e))?;
            if !status.is_success() {
                return Err(format!("Cloudflare HTTP {}: {}", status, body));
            }
            let v: serde_json::Value = serde_json::from_str(&body)
                .map_err(|e| format!("解析响应失败: {} (body: {})", e, body))?;
            if !v.get("success").and_then(|x| x.as_bool()).unwrap_or(false) {
                let msg = v
                    .get("errors")
                    .and_then(|e| e.get(0))
                    .and_then(|e| e.get("message"))
                    .and_then(|m| m.as_str())
                    .unwrap_or("未知错误");
                return Err(format!("Cloudflare 错误: {}", msg));
            }
        } else {
            let resp = http_client()?
                .post(format!("{}/zones/{}/dns_records", API_BASE, zone_id))
                .header("Authorization", format!("Bearer {}", cred.api_token))
                .json(&serde_json::json!({
                    "type": record_type,
                    "name": record_name,
                    "content": normalized_value,
                    "proxied": false,
                }))
                .send()
                .await
                .map_err(|e| format!("Cloudflare 创建记录失败: {}", e))?;

            let status = resp.status();
            let body = resp.text().await.map_err(|e| format!("读取响应失败: {}", e))?;
            if !status.is_success() {
                return Err(format!("Cloudflare HTTP {}: {}", status, body));
            }
            let v: serde_json::Value = serde_json::from_str(&body)
                .map_err(|e| format!("解析响应失败: {} (body: {})", e, body))?;
            if !v.get("success").and_then(|x| x.as_bool()).unwrap_or(false) {
                let msg = v
                    .get("errors")
                    .and_then(|e| e.get(0))
                    .and_then(|e| e.get("message"))
                    .and_then(|m| m.as_str())
                    .unwrap_or("未知错误");
                return Err(format!("Cloudflare 错误: {}", msg));
            }
        }
        Ok(())
    }

    /// 带备注的 upsert（创建/更新 DNS 记录时写入 comment 字段）
    pub async fn upsert_record_with_remarks(
        cred: &DnsCredential,
        domain: &str,
        subdomain: &str,
        record_type: &str,
        value: &str,
        remarks: &str,
    ) -> Result<(), String> {
        let zone_id = get_zone_id(cred, domain).await?;
        let records = list_records(cred, domain, Some(subdomain)).await?;
        let existing = records.into_iter().find(|r| r.name == subdomain);

        let record_name = if subdomain.is_empty() {
            domain.to_string()
        } else {
            format!("{}.{}", subdomain, domain)
        };
        let normalized_value = if record_type.eq_ignore_ascii_case("CNAME") {
            if value.ends_with('.') { value.to_string() } else { format!("{}.", value) }
        } else {
            value.to_string()
        };

        if let Some(rec) = existing {
            if rec.record_type.eq_ignore_ascii_case(record_type)
                && rec.value.trim_end_matches('.') == value.trim_end_matches('.')
            {
                return Ok(());
            }
            let resp = http_client()?
                .put(format!("{}/zones/{}/dns_records/{}", API_BASE, zone_id, rec.record_id))
                .header("Authorization", format!("Bearer {}", cred.api_token))
                .json(&serde_json::json!({
                    "type": record_type,
                    "name": record_name,
                    "content": normalized_value,
                    "proxied": false,
                    "comment": remarks,
                }))
                .send()
                .await
                .map_err(|e| format!("Cloudflare 更新记录失败: {}", e))?;

            let status = resp.status();
            let body = resp.text().await.map_err(|e| format!("读取响应失败: {}", e))?;
            if !status.is_success() {
                return Err(format!("Cloudflare HTTP {}: {}", status, body));
            }
            let v: serde_json::Value = serde_json::from_str(&body)
                .map_err(|e| format!("解析响应失败: {} (body: {})", e, body))?;
            if !v.get("success").and_then(|x| x.as_bool()).unwrap_or(false) {
                let msg = v
                    .get("errors")
                    .and_then(|e| e.get(0))
                    .and_then(|e| e.get("message"))
                    .and_then(|m| m.as_str())
                    .unwrap_or("未知错误");
                return Err(format!("Cloudflare 错误: {}", msg));
            }
        } else {
            let resp = http_client()?
                .post(format!("{}/zones/{}/dns_records", API_BASE, zone_id))
                .header("Authorization", format!("Bearer {}", cred.api_token))
                .json(&serde_json::json!({
                    "type": record_type,
                    "name": record_name,
                    "content": normalized_value,
                    "proxied": false,
                    "comment": remarks,
                }))
                .send()
                .await
                .map_err(|e| format!("Cloudflare 创建记录失败: {}", e))?;

            let status = resp.status();
            let body = resp.text().await.map_err(|e| format!("读取响应失败: {}", e))?;
            if !status.is_success() {
                return Err(format!("Cloudflare HTTP {}: {}", status, body));
            }
            let v: serde_json::Value = serde_json::from_str(&body)
                .map_err(|e| format!("解析响应失败: {} (body: {})", e, body))?;
            if !v.get("success").and_then(|x| x.as_bool()).unwrap_or(false) {
                let msg = v
                    .get("errors")
                    .and_then(|e| e.get(0))
                    .and_then(|e| e.get("message"))
                    .and_then(|m| m.as_str())
                    .unwrap_or("未知错误");
                return Err(format!("Cloudflare 错误: {}", msg));
            }
        }
        Ok(())
    }

    /// 验证凭证：调用 GET /zones 列出所有 Zone（轻量级，仅鉴权）
    pub async fn verify(cred: &DnsCredential) -> Result<(), String> {
        let resp = http_client()?
            .get(format!("{}/zones", API_BASE))
            .header("Authorization", format!("Bearer {}", cred.api_token))
            .send()
            .await
            .map_err(|e| format!("Cloudflare 验证失败: {}", e))?;

        let status = resp.status();
        let body = resp.text().await.map_err(|e| format!("读取响应失败: {}", e))?;
        if !status.is_success() {
            return Err(format!("Cloudflare HTTP {}: {}", status, body));
        }

        let value: serde_json::Value = serde_json::from_str(&body)
            .map_err(|e| format!("解析响应失败: {} (body: {})", e, body))?;

        if !value.get("success").and_then(|v| v.as_bool()).unwrap_or(false) {
            let msg = value
                .get("errors")
                .and_then(|e| e.get(0))
                .and_then(|e| e.get("message"))
                .and_then(|m| m.as_str())
                .unwrap_or("未知错误");
            return Err(format!("Cloudflare 错误: {}", msg));
        }
        Ok(())
    }

    /// 列出凭证下所有主域名（用于 TXT 清理扫描）
    pub async fn list_domains(cred: &DnsCredential) -> Result<Vec<String>, String> {
        let resp = http_client()?
            .get(format!("{}/zones", API_BASE))
            .header("Authorization", format!("Bearer {}", cred.api_token))
            .send()
            .await
            .map_err(|e| format!("Cloudflare 列出域名失败: {}", e))?;

        let status = resp.status();
        let body = resp.text().await.map_err(|e| format!("读取响应失败: {}", e))?;
        if !status.is_success() {
            return Err(format!("Cloudflare HTTP {}: {}", status, body));
        }

        let value: serde_json::Value = serde_json::from_str(&body)
            .map_err(|e| format!("解析响应失败: {} (body: {})", e, body))?;

        if !value.get("success").and_then(|v| v.as_bool()).unwrap_or(false) {
            let msg = value
                .get("errors")
                .and_then(|e| e.get(0))
                .and_then(|e| e.get("message"))
                .and_then(|m| m.as_str())
                .unwrap_or("未知错误");
            return Err(format!("Cloudflare 错误: {}", msg));
        }

        let arr = value
            .get("result")
            .and_then(|r| r.as_array())
            .ok_or("zones 返回格式异常")?;
        Ok(arr
            .iter()
            .filter_map(|z| z.get("name").and_then(|n| n.as_str()).map(String::from))
            .collect())
    }

    /// 删除指定 DNS 记录（按 record_id）
    pub async fn delete_record(
        cred: &DnsCredential,
        domain: &str,
        record_id: &str,
    ) -> Result<(), String> {
        let zone_id = get_zone_id(cred, domain).await?;
        let resp = http_client()?
            .delete(format!(
                "{}/zones/{}/dns_records/{}",
                API_BASE, zone_id, record_id
            ))
            .header("Authorization", format!("Bearer {}", cred.api_token))
            .send()
            .await
            .map_err(|e| format!("Cloudflare 删除记录失败: {}", e))?;

        let status = resp.status();
        let body = resp.text().await.map_err(|e| format!("读取响应失败: {}", e))?;
        if !status.is_success() {
            return Err(format!("Cloudflare HTTP {}: {}", status, body));
        }

        let v: serde_json::Value = serde_json::from_str(&body)
            .map_err(|e| format!("解析响应失败: {} (body: {})", e, body))?;
        if !v.get("success").and_then(|x| x.as_bool()).unwrap_or(false) {
            let msg = v
                .get("errors")
                .and_then(|e| e.get(0))
                .and_then(|e| e.get("message"))
                .and_then(|m| m.as_str())
                .unwrap_or("未知错误");
            return Err(format!("Cloudflare 错误: {}", msg));
        }
        Ok(())
    }
}

// ===== ChmlFrp 免费域名（cf-v2.uapis.cn，用户 Token 鉴权）=====
// 该模块同时服务于：
//   1. DNS 容灾切换 CNAME（通过 list_records/upsert_cname 高层接口）
//   2. DDNS 解析管理页面（通过 commands/ddns.rs 暴露的命令）
// ChmlFrp 免费 DNS 的子域名"记录"由 (主域名 domain, 记录名 record) 唯一确定，
// 无独立 record_id；删除/修改接口都通过 domain+record 定位。
pub mod chmlfrp {
    use super::*;

    const API_BASE: &str = "http://cf-v2.uapis.cn";

    /// ChmlFrp 免费 DNS 记录（get_user_free_subdomains 返回结构）
    /// 该结构同时用于 DDNS 管理页面展示
    #[derive(Clone, Debug, serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct ChmlfrpRecord {
        /// 记录唯一标识（ChmlFrp 返回的 id 字段，字符串形式）
        pub record_id: String,
        /// 用户编号
        pub user_id: String,
        /// 主域名（如 frp.wtf）
        pub domain: String,
        /// 子域名前缀（如 www）
        pub record: String,
        /// 记录类型：A / AAAA / CNAME / SRV
        pub record_type: String,
        /// 解析目标
        pub target: String,
        /// TTL 文本（如 "1分钟"）
        pub ttl: String,
        /// 备注
        pub remarks: String,
    }

    /// 校验响应状态码，code != 200 视为错误
    fn check_code(value: &serde_json::Value, label: &str) -> Result<(), String> {
        let code = value.get("code").and_then(|c| c.as_i64()).unwrap_or(0);
        if code != 200 {
            let msg = value.get("msg").and_then(|m| m.as_str()).unwrap_or("未知错误");
            return Err(format!("{} 错误: {} - {}", label, code, msg));
        }
        Ok(())
    }

    /// 获取可用主域名列表（DDNS 管理页面新建记录时选择主域名用）
    pub async fn list_available_domains() -> Result<Vec<ChmlfrpAvailableDomain>, String> {
        let resp = http_client()?
            .get(format!("{}/list_available_domains", API_BASE))
            .send()
            .await
            .map_err(|e| format!("ChmlFrp 获取可用域名列表失败: {}", e))?;

        let status = resp.status();
        let body = resp.text().await.map_err(|e| format!("读取响应失败: {}", e))?;
        if !status.is_success() {
            return Err(format!("ChmlFrp HTTP {}: {}", status, body));
        }

        let value: serde_json::Value = serde_json::from_str(&body)
            .map_err(|e| format!("解析响应失败: {} (body: {})", e, body))?;
        check_code(&value, "获取可用域名列表")?;

        let list = value.get("data").and_then(|d| d.as_array()).cloned().unwrap_or_default();
        let domains = list
            .into_iter()
            .map(|item| ChmlfrpAvailableDomain {
                id: item.get("id").and_then(|v| v.as_i64()).unwrap_or(0),
                domain: item.get("domain").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                remarks: item
                    .get("remarks")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                icp_filing: item.get("icpFiling").and_then(|v| v.as_bool()).unwrap_or(false),
                state: item.get("state").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            })
            .collect();
        Ok(domains)
    }

    /// 获取用户已有的所有免费二级域名记录
    /// 同时被 list_records 高层接口和 DDNS 管理命令复用
    pub async fn get_user_free_subdomains(
        cred: &DnsCredential,
    ) -> Result<Vec<ChmlfrpRecord>, String> {
        let resp = http_client()?
            .get(format!("{}/get_user_free_subdomains", API_BASE))
            .query(&[("token", &cred.token)])
            .send()
            .await
            .map_err(|e| format!("ChmlFrp 获取用户记录失败: {}", e))?;

        let status = resp.status();
        let body = resp.text().await.map_err(|e| format!("读取响应失败: {}", e))?;
        if !status.is_success() {
            return Err(format!("ChmlFrp HTTP {}: {}", status, body));
        }

        let value: serde_json::Value = serde_json::from_str(&body)
            .map_err(|e| format!("解析响应失败: {} (body: {})", e, body))?;
        check_code(&value, "获取用户记录")?;

        // API 文档 data 为单个对象，但实际可能为数组；兼容两种形态
        let records: Vec<ChmlfrpRecord> = match value.get("data") {
            Some(serde_json::Value::Array(arr)) => arr
                .iter()
                .map(parse_record)
                .collect::<Vec<_>>(),
            Some(obj) if obj.is_object() => vec![parse_record(obj)],
            _ => Vec::new(),
        };
        Ok(records)
    }

    /// 验证凭证：获取用户免费子域名列表（复用已有接口，仅鉴权）
    pub async fn verify(cred: &DnsCredential) -> Result<(), String> {
        get_user_free_subdomains(cred).await?;
        Ok(())
    }

    fn parse_record(item: &serde_json::Value) -> ChmlfrpRecord {
        ChmlfrpRecord {
            record_id: item.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            user_id: item.get("userid").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            domain: item.get("domain").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            record: item.get("record").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            record_type: item.get("type").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            target: item.get("target").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            ttl: item.get("ttl").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            remarks: item.get("remarks").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        }
    }

    /// 创建免费二级域名记录
    pub async fn create_free_subdomain(
        cred: &DnsCredential,
        domain: &str,
        record: &str,
        record_type: &str,
        target: &str,
        ttl: &str,
        remarks: &str,
    ) -> Result<(), String> {
        let resp = http_client()?
            .post(format!("{}/create_free_subdomain", API_BASE))
            .json(&serde_json::json!({
                "token": cred.token,
                "domain": domain,
                "record": record,
                "type": record_type,
                "target": target,
                "ttl": ttl,
                "remarks": remarks,
            }))
            .send()
            .await
            .map_err(|e| format!("ChmlFrp 创建记录失败: {}", e))?;

        let status = resp.status();
        let body = resp.text().await.map_err(|e| format!("读取响应失败: {}", e))?;
        if !status.is_success() {
            return Err(format!("ChmlFrp HTTP {}: {}", status, body));
        }

        let value: serde_json::Value = serde_json::from_str(&body)
            .map_err(|e| format!("解析响应失败: {} (body: {})", e, body))?;
        check_code(&value, "创建记录")?;
        Ok(())
    }

    /// 修改免费二级域名记录（仅允许修改 TTL 和目标）
    pub async fn update_free_subdomain(
        cred: &DnsCredential,
        domain: &str,
        record: &str,
        target: &str,
        ttl: &str,
        remarks: &str,
    ) -> Result<(), String> {
        let resp = http_client()?
            .post(format!("{}/update_free_subdomain", API_BASE))
            .json(&serde_json::json!({
                "token": cred.token,
                "domain": domain,
                "record": record,
                "target": target,
                "ttl": ttl,
                "remarks": remarks,
            }))
            .send()
            .await
            .map_err(|e| format!("ChmlFrp 修改记录失败: {}", e))?;

        let status = resp.status();
        let body = resp.text().await.map_err(|e| format!("读取响应失败: {}", e))?;
        if !status.is_success() {
            return Err(format!("ChmlFrp HTTP {}: {}", status, body));
        }

        let value: serde_json::Value = serde_json::from_str(&body)
            .map_err(|e| format!("解析响应失败: {} (body: {})", e, body))?;
        check_code(&value, "修改记录")?;
        Ok(())
    }

    /// 删除免费二级域名记录
    pub async fn delete_free_subdomain(
        cred: &DnsCredential,
        domain: &str,
        record: &str,
    ) -> Result<(), String> {
        let resp = http_client()?
            .post(format!("{}/delete_free_subdomain", API_BASE))
            .json(&serde_json::json!({
                "token": cred.token,
                "domain": domain,
                "record": record,
            }))
            .send()
            .await
            .map_err(|e| format!("ChmlFrp 删除记录失败: {}", e))?;

        let status = resp.status();
        let body = resp.text().await.map_err(|e| format!("读取响应失败: {}", e))?;
        if !status.is_success() {
            return Err(format!("ChmlFrp HTTP {}: {}", status, body));
        }

        let value: serde_json::Value = serde_json::from_str(&body)
            .map_err(|e| format!("解析响应失败: {} (body: {})", e, body))?;
        check_code(&value, "删除记录")?;
        Ok(())
    }

    /// 实现高层接口：列出主域名下指定子域名前缀的所有记录
    /// ChmlFrp 无按域名过滤的查询接口，通过 get_user_free_subdomains 全量拉取后本地过滤
    pub async fn list_records(
        cred: &DnsCredential,
        domain: &str,
        subdomain: Option<&str>,
    ) -> Result<Vec<DnsRecord>, String> {
        let all = get_user_free_subdomains(cred).await?;
        let filtered: Vec<DnsRecord> = all
            .into_iter()
            .filter(|r| r.domain == domain)
            .filter(|r| match subdomain {
                Some(sub) if !sub.is_empty() => r.record == sub,
                _ => true,
            })
            .map(|r| DnsRecord {
                record_id: r.record_id,
                record_type: r.record_type,
                name: r.record,
                value: r.target,
                line: String::new(),
            })
            .collect();
        Ok(filtered)
    }

    /// 实现高层接口：确保子域名指向指定 CNAME 值
    /// 存在则 update_free_subdomain，不存在则 create_free_subdomain
    /// 容灾切换场景固定使用 CNAME 类型，TTL 用较快的 "1分钟" 提升切换生效速度
    pub async fn upsert_record(
        cred: &DnsCredential,
        domain: &str,
        subdomain: &str,
        record_type: &str,
        value: &str,
    ) -> Result<(), String> {
        let records = list_records(cred, domain, Some(subdomain)).await?;
        let existing = records.into_iter().find(|r| r.name == subdomain);

        // 容灾/DDNS 通用备注
        let remarks = "ChmlFrp-Tunnel";

        if let Some(rec) = existing {
            if rec.record_type.eq_ignore_ascii_case(record_type) && rec.value == value {
                return Ok(());
            }
            // ChmlFrp update 接口不支持修改记录类型，类型不匹配时需先删除再创建
            if !rec.record_type.eq_ignore_ascii_case(record_type) {
                delete_free_subdomain(cred, domain, subdomain).await?;
                create_free_subdomain(cred, domain, subdomain, record_type, value, "1分钟", remarks).await?;
            } else {
                update_free_subdomain(cred, domain, subdomain, value, "1分钟", remarks).await?;
            }
        } else {
            create_free_subdomain(cred, domain, subdomain, record_type, value, "1分钟", remarks).await?;
        }
        Ok(())
    }

    /// 带备注的 upsert（使用外部传入的 remarks，供 SSL 证书验证等场景标注用途）
    pub async fn upsert_record_with_remarks(
        cred: &DnsCredential,
        domain: &str,
        subdomain: &str,
        record_type: &str,
        value: &str,
        remarks: &str,
    ) -> Result<(), String> {
        let records = list_records(cred, domain, Some(subdomain)).await?;
        let existing = records.into_iter().find(|r| r.name == subdomain);

        if let Some(rec) = existing {
            if rec.record_type.eq_ignore_ascii_case(record_type) && rec.value == value {
                return Ok(());
            }
            if !rec.record_type.eq_ignore_ascii_case(record_type) {
                delete_free_subdomain(cred, domain, subdomain).await?;
                create_free_subdomain(cred, domain, subdomain, record_type, value, "1分钟", remarks).await?;
            } else {
                update_free_subdomain(cred, domain, subdomain, value, "1分钟", remarks).await?;
            }
        } else {
            create_free_subdomain(cred, domain, subdomain, record_type, value, "1分钟", remarks).await?;
        }
        Ok(())
    }

    /// 列出凭证下所有主域名（用于 TXT 清理扫描）
    /// ChmlFrp 通过 get_user_free_subdomains 获取用户已有记录，提取去重的主域名
    pub async fn list_domains(cred: &DnsCredential) -> Result<Vec<String>, String> {
        let records = get_user_free_subdomains(cred).await?;
        let mut domains: Vec<String> = records
            .into_iter()
            .map(|r| r.domain)
            .filter(|d| !d.is_empty())
            .collect();
        // 去重并保持稳定顺序
        let mut seen = std::collections::HashSet::new();
        domains.retain(|d| seen.insert(d.clone()));
        Ok(domains)
    }

    /// 删除指定 DNS 记录（按 record_id）
    /// ChmlFrp 的删除接口通过 domain+子域名 定位，需先根据 record_id 查找子域名
    pub async fn delete_record(
        cred: &DnsCredential,
        domain: &str,
        record_id: &str,
    ) -> Result<(), String> {
        let records = get_user_free_subdomains(cred).await?;
        let target = records
            .into_iter()
            .find(|r| r.domain == domain && r.record_id == record_id)
            .ok_or_else(|| format!("未找到 record_id={} 的记录", record_id))?;
        delete_free_subdomain(cred, domain, &target.record).await
    }
}

/// ChmlFrp 可用主域名（list_available_domains 返回结构）
/// 独立定义在模块外，便于 commands/ddns.rs 引用
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChmlfrpAvailableDomain {
    /// 编号
    pub id: i64,
    /// 域名
    pub domain: String,
    /// 介绍
    pub remarks: String,
    /// 是否备案
    pub icp_filing: bool,
    /// 状态
    pub state: String,
}
