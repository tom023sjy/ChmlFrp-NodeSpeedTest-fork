# ChmlFrp SSL 证书 API 接口文档

> 基于 HAR 抓包（panel.chmlfrp.net）整理，本地维护版本。
> 抓包时间：2026-07-29（第二次更新，包含 SSO 刷新与 DNS-01 验证流程）

## 基础信息

| 项目 | 值 |
|------|-----|
| API 基础地址 | `https://cf-v2.uapis.cn` |
| 请求格式 | `application/json` |
| 响应格式 | `application/json` |
| 网页来源 | `https://panel.chmlfrp.net` |
| 认证方式 | OAuth 2.0 Bearer Token（access_token / refresh_token） |

### 认证说明

ChmlFrp 采用 OAuth 2.0 标准鉴权：

- **access_token**：用于 API 请求鉴权，有效期较短（约 600 秒）。
- **refresh_token**：用于 access_token 过期后换取新的令牌对。

HAR 抓包中 SSL 相关请求未携带 `Authorization` 头，推测 panel.chmlfrp.net 前端通过浏览器 Cookie 维持会话。
在本应用（桌面端）中调用时，应使用 ChmlFrp 账户的 `accessToken` 通过 `Authorization: Bearer {access_token}` 头进行鉴权。

### 通用响应结构

SSL 接口返回统一的 JSON 结构：

```json
{
  "msg": "描述信息",
  "code": 200,
  "data": { ... },
  "state": "success"
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `msg` | string | 提示信息 |
| `code` | number | 业务状态码，200 表示成功 |
| `data` | object / null | 业务数据 |
| `state` | string | 状态标识，`"success"` 或错误标识 |

> SSO 接口返回结构略有不同，使用 `success` / `message` / `data` 字段，见下文。

---

## 接口列表

### 1. 获取 SSL 证书列表

查询当前账户下所有 SSL 证书申请记录。

```
GET /ssl/list
```

**请求参数**：无

**响应示例**：

```json
{
  "msg": "查询成功",
  "code": 200,
  "data": {
    "total": 2,
    "certificates": [
      {
        "id": 5670,
        "provider": "zerossl",
        "domains": "ddzz.cn,ddzz.com",
        "status": "pending",
        "createdAt": "2026-07-29T13:49:20.000+00:00",
        "issuedAt": null,
        "expiresAt": null
      },
      {
        "id": 5669,
        "provider": "letsencrypt",
        "domains": "zdzz.top",
        "status": "pending",
        "createdAt": "2026-07-29T13:38:58.000+00:00",
        "issuedAt": null,
        "expiresAt": null
      }
    ]
  },
  "state": "success"
}
```

**证书对象字段**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | number | 证书申请 ID |
| `provider` | string | 证书颁发机构，`letsencrypt` 或 `zerossl` |
| `domains` | string | 申请域名（多个域名以英文逗号分隔） |
| `status` | string | 状态：`pending`（待验证）/ `issued`（已签发）/ 其他 |
| `createdAt` | string | 创建时间（ISO 8601） |
| `issuedAt` | string \| null | 签发时间，未签发时为 null |
| `expiresAt` | string \| null | 过期时间，未签发时为 null |

---

### 2. 申请 SSL 证书

向 CA 发起证书申请，创建 ACME 挑战。

```
POST /ssl/request
```

**请求体**：

```json
{
  "provider": "zerossl",
  "domains": ["ddzz.cn", "ddzz.com"],
  "challengeType": "dns01"
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `provider` | string | 证书颁发机构，`letsencrypt` 或 `zerossl` |
| `domains` | string[] | 申请域名的数组（支持多域名） |
| `challengeType` | string | 验证方式，`http01`（HTTP 域名验证）或 `dns01`（DNS 验证） |

#### 响应示例（HTTP-01）

```json
{
  "msg": "证书申请已创建，请完成域名验证",
  "code": 200,
  "data": {
    "id": 5669,
    "provider": "letsencrypt",
    "domains": "zdzz.top",
    "challengeType": "http01",
    "status": "pending",
    "challengeToken": "F0hPNcDqRVMBzz_IIsVLcqoCHO0sprg8X-5LHq7HUBc",
    "challengeKeyAuthorization": "F0hPNcDqRVMBzz_IIsVLcqoCHO0sprg8X-5LHq7HUBc.4tpKCv5QWUsCyPG4II5OYD6v4U5_iL6ZoQmQgdeX3Rk",
    "createdAt": "2026-07-29T13:38:58.416+00:00"
  },
  "state": "success"
}
```

#### 响应示例（DNS-01）

```json
{
  "msg": "证书申请已创建，请完成域名验证",
  "code": 200,
  "data": {
    "id": 5670,
    "provider": "zerossl",
    "domains": "ddzz.cn,ddzz.com",
    "challengeType": "dns01",
    "status": "pending",
    "challengeToken": "cXcMkEqUrxczc5B2YweFSx2Nop4XxekWnFX3ifqnACE.DG4QzV_p4P_SgWRb4RvnnzN6OWi5TTVGCR_UWICHOHA",
    "challengeKeyAuthorization": "6jeHxnfKgDjH51_zj_I5qMBiDMJZ_y1ZIh2DH5ccmlY",
    "instructions": "请添加以下TXT记录到您的DNS: _acme-challenge.ddzz.cn. = 6jeHxnfKgDjH51_zj_I5qMBiDMJZ_y1ZIh2DH5ccmlY",
    "dnsRecordName": "_acme-challenge.ddzz.cn.",
    "dnsRecordValue": "6jeHxnfKgDjH51_zj_I5qMBiDMJZ_y1ZIh2DH5ccmlY",
    "createdAt": "2026-07-29T13:49:19.725+00:00"
  },
  "state": "success"
}
```

**申请对象通用字段**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | number | 证书申请 ID（后续查询 / 验证用） |
| `provider` | string | 证书颁发机构 |
| `domains` | string | 申请域名（响应中为字符串，逗号分隔） |
| `challengeType` | string | 验证方式 |
| `status` | string | 初始状态为 `pending` |
| `challengeToken` | string | ACME 挑战 Token |
| `challengeKeyAuthorization` | string | ACME Key Authorization |
| `createdAt` | string | 创建时间（ISO 8601） |

**DNS-01 额外字段**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `instructions` | string | 人可读的 DNS 配置说明 |
| `dnsRecordName` | string | 需添加的 TXT 记录名（如 `_acme-challenge.ddzz.cn.`） |
| `dnsRecordValue` | string | 需添加的 TXT 记录值 |

#### HTTP-01 验证流程

申请成功后，需在域名对应的服务器上配置：

- **URL**：`http://{域名}/.well-known/acme-challenge/{challengeToken}`
- **响应内容**：`{challengeKeyAuthorization}`

#### DNS-01 验证流程

申请成功后，需在 DNS 服务商添加 TXT 记录：

- **记录名**：`{dnsRecordName}`（如 `_acme-challenge.ddzz.cn.`）
- **记录值**：`{dnsRecordValue}`

> 多域名证书仅返回第一个域名对应的 DNS 记录，其他子域名的 TXT 记录值通常相同（ACME 规范）。

配置完成后调用「验证域名」接口触发 ACME 验证。

---

### 3. 获取证书详情

查询单个证书申请的详细信息。

```
GET /ssl/detail/{id}
```

**路径参数**：

| 参数 | 类型 | 说明 |
|------|------|------|
| `id` | number | 证书申请 ID |

**响应示例**：

```json
{
  "msg": "查询成功",
  "code": 200,
  "data": {
    "id": 5669,
    "provider": "letsencrypt",
    "domains": "zdzz.top",
    "challengeType": "http01",
    "status": "pending",
    "challengeToken": "F0hPNcDqRVMBzz_IIsVLcqoCHO0sprg8X-5LHq7HUBc",
    "challengeKeyAuthorization": "F0hPNcDqRVMBzz_IIsVLcqoCHO0sprg8X-5LHq7HUBc.4tpKCv5QWUsCyPG4II5OYD6v4U5_iL6ZoQmQgdeX3Rk",
    "createdAt": "2026-07-29T13:38:58.000+00:00",
    "updatedAt": "2026-07-29T13:39:59.000+00:00",
    "issuedAt": null,
    "expiresAt": null,
    "errorMessage": "HTTP-01挑战验证失败，请检查域名是否正确解析到服务器，并确保端口80可访问。您可以稍后重新尝试验证。"
  },
  "state": "success"
}
```

**详情对象字段**（在列表字段基础上新增）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `challengeToken` | string | ACME 挑战 Token |
| `challengeKeyAuthorization` | string | ACME Key Authorization |
| `updatedAt` | string | 最后更新时间（ISO 8601） |
| `errorMessage` | string \| null | 验证失败时的错误信息，未验证或成功时为 null |
| `instructions` | string \| null | DNS-01 的配置说明（仅 DNS-01 申请有此字段） |
| `dnsRecordName` | string \| null | DNS-01 的 TXT 记录名（仅 DNS-01 申请有此字段） |
| `dnsRecordValue` | string \| null | DNS-01 的 TXT 记录值（仅 DNS-01 申请有此字段） |

---

### 4. 验证域名（触发 ACME 验证）

在域名验证资源配置就绪后，通知服务端触发 ACME 验证流程。

```
POST /ssl/verify/{id}
```

**路径参数**：

| 参数 | 类型 | 说明 |
|------|------|------|
| `id` | number | 证书申请 ID |

**请求体**：

```json
{}
```

**响应**：

- 成功时返回 `code: 200` 及更新后的证书详情（`status` 变为 `issued`）。
- 验证超时或失败时可能返回 HTTP 524（Cloudflare 超时）或包含错误信息的响应。

> **注意**：HAR 抓包中该接口返回了 HTTP 524，推测是 ACME 验证过程耗时较长导致 Cloudflare 网关超时。实际调用时建议设置较长的客户端超时时间（如 60 秒以上），并轮询证书详情接口（`GET /ssl/detail/{id}`）确认最终状态，失败时通过 `errorMessage` 字段获取失败原因。

---

### 5. 删除 SSL 证书

删除指定的证书申请记录。

```
DELETE /ssl/delete/{id}
```

**路径参数**：

| 参数 | 类型 | 说明 |
|------|------|------|
| `id` | number | 证书申请 ID |

**请求体**：无

**响应示例**：

```json
{
  "msg": "证书删除成功",
  "code": 200,
  "state": "success"
}
```

> **说明**：删除接口仅返回 `msg` / `code` / `state` 三个字段，无 `data` 字段。删除后该证书申请记录及其关联的 ACME 挑战信息将被清除，无法恢复。

---

### 6. 刷新访问令牌

当 access_token 过期时，使用 refresh_token 换取新的令牌对。

```
POST /sso/refresh
```

**请求体**：

```json
{
  "refresh_token": "tRMOuc4cU2zqf2hsxqtRY9wKq4suqIVf0Gv90JZMXwfWDsY53cGfamOftP7hUXlGHy3NFRZ9PiimqTVnLH10t4JVWjWo5tbHSiL9MoSTz1c7UXraVYsWYVYqiVNk2xCo"
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `refresh_token` | string | 上一次获取的 refresh_token |

**响应示例**：

```json
{
  "success": true,
  "message": "刷新令牌成功",
  "data": {
    "access_token": "eyJraWQiOiI3MzBiZGRmNC0zMjBjLTQ1MTItYjgxMy03OWM5ODE3NTVhMGYiLCJhbGciOiJSUzI1NiJ9...",
    "refresh_token": "DG1-55i1onBcfL7AXNfFql-DHUPGZ_e1G_Eoj5wxu_oceUK6VeWdMDWiYNR7LJtPPS8yHqXkoD7HclJNiTnMBG7m45jjn4dadu6A-vZBdUVwO8inmZLSblJkhH0lF0II",
    "expires_in": 599,
    "expires_at": 1785333557981
  }
}
```

**响应字段**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `success` | boolean | 是否成功 |
| `message` | string | 提示信息 |
| `data.access_token` | string | 新的访问令牌 |
| `data.refresh_token` | string | 新的刷新令牌（每次刷新后 refresh_token 也会轮换） |
| `data.expires_in` | number | access_token 有效期（秒） |
| `data.expires_at` | number | access_token 过期的 Unix 时间戳（毫秒） |

#### access_token JWT 载荷信息

解码 JWT 可见以下声明：

| 声明 | 值 | 说明 |
|------|-----|------|
| `iss` | `https://account-api.qzhua.net` | 签发方 |
| `aud` | `chmlfrp-api` | 受众 |
| `client_id` | `019d40ca28217ab6bae2646ac81d021c` | 客户端 ID |
| `scope` | `phone, openid, profile, offline_access, email, chmlfrp_api` | 授权范围 |
| `exp` | 1785333558 | 过期时间（Unix 秒） |
| `iat` | 1785332958 | 签发时间（Unix 秒） |

> **令牌轮换机制**：每次调用 `/sso/refresh` 后，返回的 `refresh_token` 是全新的，旧 refresh_token 失效。应用需保存最新的 refresh_token，否则下次刷新会失败。

---

## 典型调用流程

### 证书申请完整流程

```
1. POST /ssl/request          → 创建申请，获得 challengeToken / challengeKeyAuthorization / id
                                （DNS-01 还会返回 dnsRecordName / dnsRecordValue）
2a. HTTP-01：在服务器配置       → http://{域名}/.well-known/acme-challenge/{challengeToken}
    响应内容 = challengeKeyAuthorization
2b. DNS-01：在 DNS 添加 TXT    → 记录名 = dnsRecordName，记录值 = dnsRecordValue
3. POST /ssl/verify/{id}      → 触发 ACME 验证
4. GET  /ssl/detail/{id}      → 轮询状态，等待 status 变为 issued
                                失败时通过 errorMessage 获取原因
5. GET  /ssl/list             → 查看所有证书
```

### 令牌刷新流程

```
1. 检测 access_token 是否过期（对比 expires_at 与当前时间）
2. POST /sso/refresh          → 用 refresh_token 换取新的令牌对
3. 保存新的 access_token / refresh_token / expires_at
4. 用新的 access_token 重试原 API 请求
```

## 状态流转

```
pending  ──验证成功──→  issued  ──到期──→  expired
   │
   └──验证失败──→  pending（保留状态，errorMessage 记录失败原因，可重新验证）
```

## 支持的 CA 与验证方式

| CA | HTTP-01 | DNS-01 |
|----|---------|--------|
| Let's Encrypt (`letsencrypt`) | ✅ | 待确认 |
| ZeroSSL (`zerossl`) | 待确认 | ✅ |

## 备注

- 本文档基于 2026-07-29 的 HAR 抓包整理，包含 6 个接口（5 个 SSL + 1 个 SSO）。
- 证书下载 / 续期等接口未在抓包中出现，如需使用建议补充抓包或参考 ChmlFrp 官方文档。
- `provider` 字段已确认支持 `letsencrypt` 和 `zerossl`，是否支持其他 CA 待确认。
- DNS-01 验证目前抓包仅观察到单条 TXT 记录，多域名证书的完整 TXT 记录列表结构待确认。
- SSO 接口的令牌签发方为 `https://account-api.qzhua.net`，与 ChmlFrp 主域名不同，推测 ChmlFrp 使用第三方 OAuth 服务（qzhua.net）。
