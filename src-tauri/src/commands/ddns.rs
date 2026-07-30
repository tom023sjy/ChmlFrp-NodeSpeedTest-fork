// DDNS 解析管理命令
// 基于 ChmlFrp 免费域名 API（cf-v2.uapis.cn）
// 登录后直接复用 OAuth accessToken，无需用户创建凭证
// 手动 CRUD 已移除，改为 DDNS 任务自动管理（见 ddns_task.rs / ddns_monitor.rs）
// 保留：
//   1. 获取可用主域名列表（无需鉴权）
//   2. 获取用户已有解析记录（需 access_token，供查看用）
//   3. 列出本机网卡（供任务配置选择）
//   4. 手动触发一次任务检查

use super::dns_provider::{chmlfrp, ChmlfrpAvailableDomain, DnsCredential, DnsProviderKind};

/// 用 access_token 构造临时 DnsCredential
fn build_credential(access_token: &str) -> Result<DnsCredential, String> {
    if access_token.trim().is_empty() {
        return Err("未提供 access_token，请先登录".to_string());
    }
    Ok(DnsCredential {
        id: String::new(),
        name: String::new(),
        provider: DnsProviderKind::Chmlfrp,
        secret_id: String::new(),
        secret_key: String::new(),
        token: access_token.to_string(),
        api_token: String::new(),
        owner_username: String::new(),
    })
}

/// 获取 ChmlFrp 可用的主域名列表（无需鉴权）
#[tauri::command]
pub async fn ddns_list_available_domains() -> Result<Vec<ChmlfrpAvailableDomain>, String> {
    chmlfrp::list_available_domains().await
}

/// 获取用户已有的所有免费二级域名解析记录（供查看）
#[tauri::command]
pub async fn ddns_list_records(
    access_token: String,
) -> Result<Vec<chmlfrp::ChmlfrpRecord>, String> {
    let cred = build_credential(&access_token)?;
    chmlfrp::get_user_free_subdomains(&cred).await
}
