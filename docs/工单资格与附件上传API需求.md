# 工单资格限制与附件上传 API 后端实施需求

> **交付对象**：ChmlFrp 社区工具箱 API 后端开发 AI
> **后端项目**：`backend`
> **客户端项目**：`NodeSpeedTest`
> **优先级**：P0，当前新版客户端提交链路依赖本需求
> **更新日期**：2026-08-16

## 一、任务目标

在现有工单系统上完整实现以下能力：

1. 用户首次登录社区工具箱满 24 小时后才能提交工单；会员用户（`users.usergroup` 分组名包含“会员”二字）免除该 24 小时冷却。
2. 每个用户按北京时间自然日最多提交 5 个工单。
3. 管理员可禁用或恢复指定用户的工单提交权限，并可填写公开禁用原因。
4. 客户端打开工单弹窗时可预检提交资格和今日剩余额度。
5. `POST /api/issues/submit` 支持 `multipart/form-data`，最多携带 3 个图片或视频附件。
6. 附件必须经过服务端文件类型、安全性、大小和访问权限校验。
7. 保证并发请求不能绕过每日 5 次限制，正常失败路径立即清理，进程崩溃遗留由对账任务自动清理。
8. 在一个客户端版本兼容期内继续接受无附件的旧 JSON 请求。

客户端已经按本文接口发送请求。后端不得要求客户端修改字段名、手动设置 multipart boundary，或把客户端预检当成最终安全校验。

## 二、当前实现缺口

后端 AI 开发前必须先理解以下现状，不得把已有代码误判为需求已完成：

- `backend/src/routes/issues.js` 当前只解析 JSON，未给工单提交路由配置 multipart 中间件。
- 客户端把 `captcha` 作为 JSON 字符串写入 `FormData`；当前极验中间件无法从未解析的 multipart 请求中读取该字段。
- `GET /api/issues/submit-permission` 尚未实现，并可能被现有 `GET /api/issues/:id` 动态路由错误匹配。
- 现有 24 小时限制使用 `auth_tokens.MIN(created_at)`，必须改为 `users.first_login`。
- 现有每日限额先查询再插入，没有事务和用户级数据库锁，并发请求可绕过限制。
- 数据库当前没有工单附件表，也没有附件下载接口。
- 管理端当前删除工单时不会处理附件，必须同步改造删除流程。
- 前端已经发送 multipart；在后端完成前，新版客户端工单提交会失败。

## 三、范围与边界

### 必须修改或新增的后端模块

- `backend/src/routes/issues.js`：资格预检、multipart 提交、附件下载及详情附件数据。
- `backend/src/services/issueGuard.js`：统一资格模型、北京时间额度和事务内检查。
- `backend/src/middleware/geetest.js`：兼容 multipart 中的 `captcha` JSON 字符串。
- `backend/src/db/migrate-runner.js`：新增附件元数据表及必要索引。
- `backend/src/routes/admin.js` 及工单管理页面：管理员附件查看、鉴权下载和受控删除。
- 新建独立附件服务，例如 `backend/src/services/issueAttachments.js`，负责规则、文件签名、落盘和清理。
- 新建独立上传中间件，例如 `backend/src/middleware/issueUpload.js`，负责 multer 限制和错误映射。
- 新增或扩展 `backend/test` 下的工单资格、提交、附件和下载测试。

### 不在本任务范围

- 不修改客户端字段契约。
- 不创建对象存储、数据库实例、容器、网站或反向代理。
- 不把附件放入公开静态目录。
- 不更改现有工单状态流转逻辑。

### 已追加实现的能力（2026-08-17 更新）

以下能力在原始需求基础上已按用户指示追加并完成实现，视为本任务的一部分：

1. **回复附件**：用户端 `POST /api/issues/:id/reply` 与管理端 `POST /admin/api/issues/:id/reply` 均支持 `multipart/form-data`，最多携带 3 个图片或视频附件；附件通过 `issue_attachments.reply_id` 与回复关联，一条回复可有多个附件。
2. **附件在线预览**：
   - 用户端：`GET /api/issues/:issueId/attachments/:attachmentId/preview-url` 签发 HMAC 签名短期预览令牌（10 分钟有效），`GET /api/issues/attachments/inline/:token` 凭令牌 inline 流式返回（支持 Range 请求，视频可拖动播放）。
   - 管理端：`GET /admin/api/issues/:issueId/attachments/:attachmentId/inline` 鉴权后 inline 返回。
   - 图片展示缩略图并支持点击放大（Lightbox），视频直接在线播放。
3. **管理端交互优化**：回复表单不再内嵌状态选择下拉框，工单状态统一由详情页右上角独立状态切换控件修改。

## 四、资格判定规则

资格规则必须按以下优先级执行：

1. **工单权限禁用**：`issue_user_flags.banned = 1` 时禁止提交。
2. **新用户冷却**：以 `users.first_login` 为唯一基准，未满 24 小时禁止提交；会员用户（`users.usergroup` 分组名包含“会员”二字，如“定制会员”“高级会员”）跳过本条冷却检查，封禁与每日额度仍然生效。
3. **每日额度**：按 `Asia/Shanghai` 自然日统计当前用户已成功创建的工单，最多 5 个。

禁止使用 `auth_tokens.created_at` 推断首次登录时间。令牌可能被删除、轮换或在不同设备创建，不能作为稳定账号年龄依据。

所有资格响应必须使用同一个数据模型：

```json
{
  "success": true,
  "allowed": true,
  "code": "ISSUE_SUBMIT_ALLOWED",
  "message": "可以提交工单",
  "dailyLimit": 5,
  "submittedToday": 2,
  "remainingToday": 3,
  "firstLoginAt": "2026-08-14T08:00:00.000Z",
  "eligibleAt": "2026-08-15T08:00:00.000Z",
  "bannedReason": null
}
```

字段要求：

- `success`：资格接口成功执行时固定为 `true`，即使用户当前不允许提交。
- `allowed`：当前是否允许提交。
- `code`：稳定业务错误码。
- `dailyLimit`：固定为 `5`。
- `submittedToday`：北京时间当天已成功创建的工单数。
- `remainingToday`：`max(0, dailyLimit - submittedToday)`；冷却或封禁时返回 `0`。
- `firstLoginAt`：`users.first_login` 的 ISO 8601 时间；数据异常时不得静默跳过限制。
- `eligibleAt`：首次登录时间加 24 小时；已有资格时也可返回该历史时间；会员豁免冷却时为 `null`。
- `vipCooldownExempt`：是否为会员并已豁免 24 小时新用户冷却（分组名包含“会员”二字时为 `true`）。
- `bannedReason`：管理员填写的公开原因，未禁用时为 `null`。

`code` 只能使用：

- `ISSUE_SUBMIT_ALLOWED`
- `ISSUE_BANNED`
- `ISSUE_NEW_USER_COOLDOWN`
- `ISSUE_DAILY_LIMIT`
- `ISSUE_ACCOUNT_AGE_UNAVAILABLE`

禁止向客户端返回 `banned_by`、管理员账号、内部备注或 SQL 错误。

用户不存在、`first_login` 为 `NULL` 或无法解析时，预检返回 HTTP 503，提交接口返回 HTTP 503，错误码固定为 `ISSUE_ACCOUNT_AGE_UNAVAILABLE`。该情况必须失败关闭，禁止跳过冷却限制；会员豁免冷却时不依赖账号年龄，不受本条约束。

## 五、资格预检接口

### 请求

```http
GET /api/issues/submit-permission
Authorization: Bearer <accessToken>
Cache-Control: no-store
```

路由必须声明在 `GET /api/issues/:id` 之前，防止 `submit-permission` 被解析成工单 ID。

### 响应规则

- 已认证且查询成功：统一 HTTP 200，通过 `allowed` 表达限制状态。
- 未认证：沿用现有认证中间件的 401 响应。
- 功能关闭：沿用 `requireFeature('issueFeedback')` 的现有响应。
- 数据库异常：HTTP 500，使用稳定通用错误码，不返回内部异常详情。

新用户不可提交示例：

```json
{
  "success": true,
  "allowed": false,
  "code": "ISSUE_NEW_USER_COOLDOWN",
  "message": "首次登录满 24 小时后才能提交工单",
  "dailyLimit": 5,
  "submittedToday": 0,
  "remainingToday": 0,
  "firstLoginAt": "2026-08-16T08:00:00.000Z",
  "eligibleAt": "2026-08-17T08:00:00.000Z",
  "bannedReason": null
}
```

## 六、提交工单接口

保持路径：

```http
POST /api/issues/submit
Authorization: Bearer <accessToken>
Content-Type: multipart/form-data; boundary=<由客户端运行时生成>
```

客户端不会手动设置 `Content-Type`。后端必须使用现有依赖 `multer` 或等价的流式 multipart 解析器，禁止先把整个 200 MiB 请求读入内存。

### 文本字段

- `title`：必填，去除首尾空白后 1 至 200 个字符。
- `description`：必填，去除首尾空白后不能为空，最多 10000 个 Unicode 码点且 UTF-8 编码后不超过 40 KiB。
- `category`：只允许 `bug`、`feature`、`other`，无效值回退为 `other`。
- `appVersion`：选填，最长 20 个字符。
- `platform`：选填，最长 20 个字符。
- `contactEmail`：选填，最长 200 个字符，沿用现有邮箱格式校验。
- `contactPhone`：选填，最长 50 个字符，沿用现有国际号码格式校验。
- `captcha`：必填 JSON 字符串，结构如下。

文本字段必须为字符串。标题或描述不符合要求时分别返回 `ISSUE_TITLE_INVALID`、`ISSUE_DESCRIPTION_INVALID`；其他文本字段类型或长度不合法时返回 `ISSUE_FIELD_INVALID`。

```json
{
  "lot_number": "...",
  "captcha_output": "...",
  "pass_token": "...",
  "gen_time": "..."
}
```

上传中间件必须先完成 multipart 字段解析，再调用极验中间件。极验中间件发现 `req.body.captcha` 是字符串时必须安全执行 `JSON.parse`；解析失败返回 400 或 403 的稳定验证码错误，不能抛出未捕获异常。

### 附件字段

- 字段名固定为 `attachments`，允许重复出现。
- 最多 3 个附件。
- 图片单文件最大 10 MiB。
- 视频单文件最大 100 MiB。
- 一次请求全部附件总大小最大 200 MiB。
- 空文件必须拒绝。

允许类型映射：

| 扩展名 | 声明 MIME | 文件签名要求 |
|---|---|---|
| `.jpg`、`.jpeg` | `image/jpeg` | JPEG SOI：`FF D8 FF` |
| `.png` | `image/png` | PNG：`89 50 4E 47 0D 0A 1A 0A` |
| `.gif` | `image/gif` | `GIF87a` 或 `GIF89a` |
| `.mp4` | `video/mp4` | ISO BMFF，前部存在合法 `ftyp` box |
| `.mkv` | `video/x-matroska` | EBML：`1A 45 DF A3` |

扩展名、MIME 和文件签名必须三者一致。只检查其中一项不符合验收要求。后端必须显式增加并锁定兼容当前 Node.js ESM 环境的成熟文件识别依赖，例如 `file-type`，不能仅依赖手写魔数判断。文件识别库无法确认、文件截断或容器结构非法时一律拒绝。

原始文件名只作为展示元数据保存。清洗时必须先把反斜杠统一为正斜杠，再取最后一个路径段；移除 NUL、CR/LF、C0/C1 控制字符和双向文本控制符，并限制为最多 255 个 UTF-8 字节。禁止把原始文件名参与实际存储路径生成。

### 成功响应

```json
{
  "success": true,
  "issueId": 123,
  "message": "工单已提交，我们会尽快处理",
  "remainingToday": 2,
  "attachments": [
    {
      "id": 456,
      "name": "截图.png",
      "mimeType": "image/png",
      "size": 245760,
      "downloadUrl": "/api/issues/123/attachments/456/download"
    }
  ]
}
```

### 资格限制错误

- HTTP 403 + `ISSUE_BANNED`
- HTTP 403 + `ISSUE_NEW_USER_COOLDOWN`
- HTTP 429 + `ISSUE_DAILY_LIMIT`

限制错误必须返回完整资格字段，而不是只返回 `code` 和 `message`。示例：

```json
{
  "success": false,
  "allowed": false,
  "code": "ISSUE_DAILY_LIMIT",
  "message": "今日工单额度已用完",
  "dailyLimit": 5,
  "submittedToday": 5,
  "remainingToday": 0,
  "firstLoginAt": "2026-08-01T08:00:00.000Z",
  "eligibleAt": "2026-08-02T08:00:00.000Z",
  "bannedReason": null
}
```

### 附件错误码

- HTTP 400 + `ISSUE_ATTACHMENT_COUNT_EXCEEDED`
- HTTP 400 + `ISSUE_ATTACHMENT_EMPTY`
- HTTP 400 + `ISSUE_ATTACHMENT_TYPE_INVALID`
- HTTP 413 + `ISSUE_ATTACHMENT_TOO_LARGE`
- HTTP 500 + `ISSUE_ATTACHMENT_STORE_FAILED`

所有错误响应必须为 JSON，至少包含 `success: false`、稳定 `code` 和可直接展示的中文 `message`。

## 七、数据库变更

在迁移运行器中新增以下等价结构。表名和字段名若因现有规范需要调整，最终 API 字段不得改变。

```sql
CREATE TABLE IF NOT EXISTS issue_attachments (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  issue_id      INT NOT NULL,
  user_id       INT NOT NULL,
  original_name VARCHAR(255) NOT NULL,
  stored_name   VARCHAR(100) NOT NULL,
  mime_type     VARCHAR(100) NOT NULL,
  extension     VARCHAR(10) NOT NULL,
  size_bytes    BIGINT UNSIGNED NOT NULL,
  sha256        CHAR(64) NOT NULL,
  storage_key   VARCHAR(255) NOT NULL,
  status        ENUM('pending','ready','delete_pending') NOT NULL DEFAULT 'pending',
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_issue_attachment_stored_name (stored_name),
  INDEX idx_issue_attachment_issue (issue_id),
  INDEX idx_issue_attachment_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS issue_daily_usage (
  user_id       INT NOT NULL,
  usage_date    DATE NOT NULL,
  submitted_count TINYINT UNSIGNED NOT NULL DEFAULT 0,
  updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, usage_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

要求：

- `stored_name` 使用 `crypto.randomUUID()` 或等强度随机值生成，并保留经服务端确认的扩展名。
- `sha256` 在文件校验或落盘过程中计算。
- 不依赖客户端提供哈希。
- 不把文件二进制存入 MySQL。
- 数据库只保存相对于附件根目录的 `storage_key`，禁止保存服务器绝对路径。
- 给 `issues` 增加复合索引 `INDEX idx_issues_user_created (user_id, created_at)`，迁移必须幂等。
- `issue_attachments.issue_id` 使用受控删除流程，不允许依赖数据库级联后遗漏磁盘文件。

### 历史用户迁移

迁移必须检查现有生产 `users` 表是否存在 `first_login`：

1. 缺列时先新增允许 `NULL` 的 `first_login DATETIME`。
2. 对历史用户按其现存 `auth_tokens.created_at`、`usage_logs.created_at` 和 `oauth_sessions.created_at` 的最早可信时间回填。
3. 完全没有可信历史记录的用户统一回填为本次迁移执行时间，因此需再等待 24 小时；不得伪造更早时间绕过防滥用规则。
4. 回填完成后把该列改为非空，并为新用户保留 `DEFAULT CURRENT_TIMESTAMP`。
5. 将北京时间当天现有 `issues` 数量回填到 `issue_daily_usage`，后续以计数表为每日额度唯一数据源。

工单被管理员删除后不得返还当日额度。创建成功时事务内递增 `issue_daily_usage.submitted_count`，删除工单时不得递减。

## 八、附件存储要求

本需求默认使用服务器本地持久化目录，不指定或创建对象存储资源。

- 通过环境变量配置根目录，例如 `ISSUE_ATTACHMENT_DIR`。
- 生产环境未配置 `ISSUE_ATTACHMENT_DIR` 时后端必须启动失败；开发和测试环境可使用明确的应用数据目录默认值。
- Linux 部署目录必须位于持久化可写位置，例如 `/var/lib/cct-backend/issue-attachments`。
- Windows 开发环境必须使用 `path.join`、`path.resolve`，禁止硬编码 `/` 路径。
- 禁止使用 `/tmp`、项目源码目录、`public` 静态目录或可直接通过 Web 访问的目录。
- 启动时验证目录可创建、可写；不可写时提交附件应返回明确服务错误。
- 临时文件和最终文件必须位于同一受控根目录内，便于原子移动和失败清理。
- 文件最终权限应遵循最小权限原则，不赋予可执行权限。
- 根目录不得是符号链接；读取附件前必须确认目标是常规文件。
- 临时文件超过 24 小时必须由定时清理任务删除。
- 上传前检查磁盘剩余空间，低于 1 GiB 或小于本次请求声明上限两倍时拒绝新附件上传。

实际存储路径必须通过 `path.resolve(root, storageKey)` 生成，再使用 `path.relative(root, candidate)` 校验。相对结果为空以外，若为绝对路径、等于 `..` 或以 `..${path.sep}` 开头必须拒绝。禁止只用字符串 `startsWith` 判断目录归属。

生产环境如运行在容器中，部署方必须在另行授权后配置宿主机绑定挂载或持久卷，并配置目录属主、权限、容量监控和备份。后端 AI 只需在部署文档列明前置条件，不得擅自创建容器或存储资源。

## 九、事务与并发控制

提交接口必须按以下顺序执行：

1. 功能开关检查。
2. 用户认证。
3. 基本请求频率限制。
4. multipart 解析到受控临时目录，并执行数量和总大小限制。
5. 解析并校验验证码字段，完成极验服务端验证。
6. 校验文本字段及所有附件的扩展名、MIME、签名和大小。
7. 从连接池获取独占数据库连接并开启事务。
8. 执行 `SELECT id, first_login FROM users WHERE id = ? FOR UPDATE`，锁定当前用户记录。
9. 在同一事务、同一数据库连接中重新检查封禁状态、24 小时冷却，并锁定或创建当天 `issue_daily_usage` 记录。
10. 插入 `issues` 记录。
11. 插入状态为 `pending` 的 `issue_attachments` 元数据，并递增当天 `submitted_count`。
12. 在数据库事务保持打开期间，将已验证临时文件原子移动到最终随机路径。
13. 文件全部移动成功后，在同一事务中把附件状态更新为 `ready`。
14. 提交数据库事务。
15. 返回工单、剩余额度和状态为 `ready` 的附件元数据。

任一步失败时必须：

- 数据库提交前发生文件移动或状态更新失败时，回滚事务并删除本次请求的全部临时文件和最终文件。
- 数据库已提交但响应发送失败时不得删除已成功创建的工单；客户端可通过工单列表确认结果。
- 释放数据库连接。
- 不删除其他请求或其他工单的文件。

仅在事务外先执行一次资格检查不够。必须通过用户行锁和当天额度记录把“读取额度、递增额度、插入工单”串行化，保证两个并发请求争夺第 5 个额度时只有一个成功。

MySQL 事务不能回滚文件系统操作，因此不得宣称数据库与磁盘完全原子。必须实现附件对账任务：扫描超过 10 分钟仍为 `pending` 或 `delete_pending` 的记录、数据库不存在的过期临时文件和最终文件，完成状态修复或删除。只有 `ready` 附件可出现在 API 响应和下载接口中。对账扫描必须设置目录和单轮处理数量上限，不能长期阻塞主服务。

## 十、附件查询与下载

### 工单详情

`GET /api/issues/:id` 的 `data` 中新增：

```json
{
  "attachments": [
    {
      "id": 456,
      "name": "截图.png",
      "mimeType": "image/png",
      "size": 245760,
      "downloadUrl": "/api/issues/123/attachments/456/download"
    }
  ]
}
```

列表接口不需要返回附件完整信息，可选返回 `attachmentCount`。

### 用户下载接口

```http
GET /api/issues/:issueId/attachments/:attachmentId/download
Authorization: Bearer <accessToken>
```

必须同时校验：

- 工单存在。
- 工单属于当前登录用户。
- 附件属于该工单。
- 文件解析后的实际路径仍位于附件根目录中。

响应要求：

- 使用 `Content-Disposition: attachment`。
- 下载文件名使用安全编码后的原始文件名。
- 设置 `X-Content-Type-Options: nosniff`。
- 不允许通过猜测附件 ID 下载他人的文件。
- 数据库记录存在但文件缺失时返回 404 或稳定的文件缺失错误，不泄露服务器绝对路径。

### 管理员访问与删除

管理员工单详情必须展示附件元数据，并通过独立的管理员认证下载路由访问附件。现有管理员和超级管理员只要具备工单查看权限即可下载，不得绕过管理员认证直接暴露普通用户下载 URL。

现有管理端单个或批量删除工单流程必须调用附件服务：先将附件标记为 `delete_pending`，删除工单及关联元数据，再删除磁盘文件。磁盘删除失败必须进入对账重试；不得因为文件删除失败导致工单删除接口返回已删除但永久遗留文件。删除工单不得递减 `issue_daily_usage`。

## 十一、旧客户端兼容

后端必须在至少一个客户端版本周期内同时接受：

1. `application/json`：现有无附件提交格式，验证码字段可为 `captcha` 对象或现有扁平 GT4 字段。
2. `multipart/form-data`：本文定义的新格式，`captcha` 为 JSON 字符串，附件字段为 `attachments`。

两种格式必须执行完全相同的认证、极验、资格、文本校验和事务逻辑。禁止维护两套独立的工单插入实现。

兼容期结束前不得删除 JSON 支持。后续删除时需要先确认线上旧客户端占比并更新客户端最低版本策略。

## 十二、安全要求

- 客户端校验不能替代服务端校验。
- 不信任原始文件名、扩展名、MIME、客户端哈希和客户端预检结果。
- 不在日志中记录验证码完整字段、访问令牌、联系方式全文或附件内容。
- 日志可记录请求 ID、用户 ID、工单 ID、附件数量、错误码和脱敏后的文件类型。
- multer 必须限制 `files: 3`、字段数量、单字段大小和单文件上限；总大小和按媒体类型大小仍需业务层校验。
- 工单提交必须增加独立的用户级与 IP 级限流，并限制单用户并发上传为 1；不能只依赖现有全局每 IP 每分钟限流。
- 请求解析和文件校验必须设置超时，超时后关闭请求并清理临时文件。
- 上传解析错误必须统一转为 JSON，不允许 Express 返回 HTML 错误页。
- 未配置极验密钥的生产环境不得把任意完整字段视为验证通过；生产启动应失败或敏感接口明确拒绝服务。
- 附件不应直接以内联方式返回，尤其是视频和可伪装内容。
- 所有数据库查询使用参数化语句。

## 十三、错误响应封装

后端必须统一使用以下结构，便于客户端现有 `BackendApiError` 保留错误详情：

```json
{
  "success": false,
  "code": "ISSUE_ATTACHMENT_TYPE_INVALID",
  "message": "附件类型不受支持或文件内容与类型不一致",
  "details": {
    "fileName": "example.png"
  }
}
```

资格限制的 `dailyLimit`、`submittedToday`、`remainingToday`、`firstLoginAt`、`eligibleAt`、`bannedReason` 必须位于响应顶层。客户端当前直接从顶层响应详情读取这些字段，禁止再嵌套到 `details`。

## 十四、测试要求

后端 AI 必须先补失败测试，再实现功能。至少覆盖以下场景：

### 资格测试

1. `users.first_login` 距当前 23 小时 59 分时返回 `ISSUE_NEW_USER_COOLDOWN`。
2. 满 24 小时边界允许提交。
3. 北京时间 23:59:59 的工单计入当天，00:00:00 后额度重置。
4. 当天已有 4 个工单时剩余 1 个；已有 5 个时返回 `ISSUE_DAILY_LIMIT`。
5. 封禁优先于冷却和每日额度，并返回公开 `bannedReason`。
6. 解封后重新按冷却和额度规则判断。
7. 两个并发请求争夺最后一个额度时仅一个成功。
8. 管理员删除当天工单后额度不恢复。
9. `first_login` 缺失或非法时失败关闭并返回 `ISSUE_ACCOUNT_AGE_UNAVAILABLE`。

### multipart 与极验测试

1. 无附件 multipart 请求可成功解析文本字段和 `captcha` JSON 字符串。
2. `captcha` 非法 JSON 返回稳定 JSON 错误。
3. 验证码失败时不创建工单、不保留文件。
4. 旧 JSON 请求仍可提交无附件工单。

### 附件测试

1. 合法 JPG、JPEG、PNG、GIF、MP4、MKV 分别可提交。
2. 4 个附件返回 `ISSUE_ATTACHMENT_COUNT_EXCEEDED`。
3. 空文件返回 `ISSUE_ATTACHMENT_EMPTY`。
4. 图片超过 10 MiB、视频超过 100 MiB、总计超过 200 MiB 分别被拒绝。
5. 修改扩展名、伪造 MIME、文件签名不匹配分别被拒绝。
6. 文件名包含 `../`、绝对路径、反斜杠或 Unicode 特殊字符时不会逃逸存储目录。
7. 数据库插入失败后临时文件和最终文件均被删除。
8. 文件移动失败后事务回滚，不产生工单和附件记录，并删除已移动的本次请求文件。
9. 模拟数据库提交后进程中断，附件保持不可下载，并在对账周期内完成清理。

### 下载鉴权测试

1. 工单所有者可下载附件。
2. 其他普通用户访问同一 URL 返回 404 或 403，不能下载文件。
3. 附件 ID 与工单 ID 不匹配时拒绝。
4. 文件缺失时不泄露绝对路径。
5. 响应包含 `Content-Disposition: attachment` 和 `X-Content-Type-Options: nosniff`。
6. 管理员通过管理员认证可下载，未认证请求不可下载。
7. 删除工单后附件文件被删除；模拟删除失败时由对账任务重试。

## 十五、交付顺序

1. 增加 `first_login` 历史迁移、每日额度表、附件表和复合索引迁移测试。
2. 重构资格服务，以 `users.first_login` 为基准并返回完整资格模型。
3. 实现资格预检接口，确保路由顺序正确。
4. 实现 multipart 上传中间件和统一错误映射。
5. 兼容解析 multipart `captcha` JSON 字符串。
6. 实现事务内资格检查、工单插入、附件落盘和失败清理。
7. 实现详情附件数据、用户鉴权下载、管理员查看下载和受控删除流程。
8. 保留旧 JSON 提交并复用同一业务服务。
9. 补齐集成、并发、安全和回滚测试。
10. 实现 pending/delete_pending 对账和过期临时文件清理任务。
11. 更新后端 README、环境变量示例、反向代理请求体上限和部署目录权限说明；基础设施变更只列前置条件，等待用户授权执行。

## 十六、完成标准

只有同时满足以下条件才能声明后端任务完成：

- `GET /api/issues/submit-permission` 与本文响应一致。
- 首次登录未满 24 小时、当日已有 5 个工单或已被禁用的用户无法绕过提交限制。
- 并发请求不能创建第 6 个工单。
- 新版客户端 multipart 请求可通过极验并成功提交无附件或带附件工单。
- 最多 3 个合法附件可成功保存，并由工单详情 API 和管理端详情返回或展示。
- 伪造类型、超限、路径穿越、空文件和越权下载均被拒绝。
- 正常错误路径立即清理；进程崩溃产生的非 ready 记录或孤立文件在 10 分钟对账周期内清理。
- 旧 JSON 客户端仍能提交无附件工单。
- Windows 开发环境与 Linux 部署环境均通过测试，路径处理无平台硬编码。
- 后端完整测试套件通过，且新增测试覆盖本文所有关键验收场景。

## 十七、实施记录

截至 2026-08-16，后端已按本文范围完成以下实现：

- 新增统一资格模型和 `GET /api/issues/submit-permission`，以 `users.first_login`、管理员封禁和北京时间每日额度为准。
- 提交接口同时兼容旧 JSON 与新版 multipart，请求先流式解析附件，再解析 multipart 中的 `captcha` JSON 并执行极验二次校验。
- 附件限制为最多 3 个，支持 JPG、JPEG、PNG、GIF、MP4、MKV，并校验扩展名、声明 MIME、内容识别、结构完整性、单文件大小和总大小，截断图片或媒体容器会被拒绝。
- 附件使用随机存储名和受控私有目录，读写前校验路径归属、父目录和符号链接；下载仅允许工单所有者或已认证管理员访问。
- 工单创建在用户行锁和当日额度记录锁下完成；附件元数据、额度递增、工单插入和文件移动共享同一事务边界，并区分提交前失败与 COMMIT 结果不确定场景。
- 单个或批量删除工单统一进入附件受控删除流程；清理失败保留 `delete_pending`，由 10 分钟对账任务重试。
- 对账任务处理超时 `pending`、`delete_pending`、孤立最终文件和超过 24 小时的临时文件，并限制单轮扫描数量。
- 上传链路具备 IP 与用户级限流、单用户并发限制、覆盖解析、识别和哈希的两分钟截止时间，以及稳定 JSON 错误映射。
- 认证缓存使用完整令牌的 SHA-256 摘要作为键，避免公共令牌前缀碰撞造成身份混淆；历史首次登录回填在认证令牌和使用日志清理前执行。
- 提交失败时即使数据库回滚本身报错，也会独立清理本次请求的临时文件和已移动最终文件；对账任务先筛选过期或孤立候选，再应用单轮处理上限，避免目录项饥饿。

验证记录：`backend` 目录执行 `npm test`，128 项测试全部通过；相关 JavaScript 文件通过 `node --check`，差异通过 `git diff --check`。项目当前未提供 lint 或 typecheck 脚本。数据库迁移命令需要可用的 MySQL 实例，本次未创建或部署数据库、容器、网站、反向代理和存储挂载，也未执行 Git 提交。

生产启用前置条件：部署方需配置 `ISSUE_ATTACHMENT_DIR` 到持久化可写目录，确保可用空间不低于 1 GiB，并将反向代理请求体上限设置为大于 200 MiB（建议 210 MiB）。这些基础设施操作必须另行授权后执行。
