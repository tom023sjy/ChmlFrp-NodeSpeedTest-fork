/**
 * 自建后端 API 服务
 *
 * 对接部署在官方服务器的后端（使用量统计、登录、问题上报）。
 * 后端地址统一由 `@/lib/api-endpoints` 管理，如需变更仅修改该文件。
 *
 * 后端文档概要：
 * - 登录：浏览器 OAuth 流程（/auth/login → /auth/status 轮询）
 * - 使用量上报：POST /api/usage/report（需 Bearer 认证）
 * - 问题上报：POST /api/issues/submit（需 Bearer 认证 + 极验 GT4 验证码）
 * - 问题查询：GET /api/issues/list、GET /api/issues/:id（需 Bearer 认证）
 * - 极验配置：GET /auth/captcha/config（返回 GT4 captcha_id）
 */
import { getVersion } from "@tauri-apps/api/app";
import { BACKEND_API_BASE_URL } from "@/lib/api-endpoints";
import { getStoredUser, type StoredUser } from "@/services/api";

// ===== 类型定义 =====

/** 使用量事件类型（与后端 allowedTypes 保持一致） */
export type UsageEventType = string;

/** 使用量上报请求体 */
export interface UsageReportPayload {
  eventType: UsageEventType;
  eventData?: Record<string, unknown>;
  appVersion?: string;
  platform?: string;
  eventId?: string;
  eventVersion?: number;
  sessionId?: string;
  clientTime?: string;
}

/** 使用量上报响应 */
export interface UsageReportResponse {
  success: boolean;
  message?: string;
}

/** 极验 GT4 公开配置（前端初始化 SDK 用） */
export interface GeetestConfig {
  enabled: boolean;
  captcha_id: string;
}

/** 极验 GT4 验证结果（由前端 SDK 返回，提交给后端二次校验） */
export interface GeetestValidation {
  lot_number: string;
  captcha_output: string;
  pass_token: string;
  gen_time: string;
}

/** 问题分类 */
export type IssueCategory = "bug" | "feature" | "other";

/** 工单上报请求体 */
export interface IssueSubmitPayload {
  title: string;
  description: string;
  category?: IssueCategory;
  appVersion?: string;
  platform?: string;
  /** 联系邮箱（选填，留空即匿名） */
  contactEmail?: string;
  /** 联系手机号（选填，留空即匿名） */
  contactPhone?: string;
  attachments?: File[];
}

export interface IssueSubmitPermission {
  success: boolean;
  allowed: boolean;
  code: "ISSUE_SUBMIT_ALLOWED" | "ISSUE_BANNED" | "ISSUE_NEW_USER_COOLDOWN" | "ISSUE_DAILY_LIMIT";
  message: string;
  dailyLimit: number;
  submittedToday: number;
  remainingToday: number;
  firstLoginAt: string | null;
  eligibleAt: string | null;
  bannedReason: string | null;
}

/** 问题上报响应 */
export interface IssueSubmitResponse {
  success: boolean;
  issueId: number;
  message: string;
}

/** 问题列表项 */
export interface IssueListItem {
  id: number;
  title: string;
  description: string;
  category: string;
  status: string;
  app_version: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  created_at: string;
  updated_at: string;
}

/** 问题列表响应 */
export interface IssueListResponse {
  success: boolean;
  data: IssueListItem[];
  total: number;
  page: number;
  pageSize: number;
}

/** 工单附件 */
export interface IssueAttachment {
  id: number;
  name: string;
  mimeType: string;
  size: number;
  /** 归属回复 ID，null 表示工单主附件 */
  replyId: number | null;
  downloadUrl: string;
}

/** 工单回复 */
export interface IssueReply {
  id: number;
  issue_id: number;
  /** 回复者用户名。管理员回复时为管理员用户名，用户回复时为提交工单的用户名 */
  replied_by?: string | null;
  content: string;
  created_at: string;
  /** 该回复携带的附件 */
  attachments: IssueAttachment[];
}

/** 工单详情 */
export interface IssueDetail {
  id: number;
  title: string;
  description: string;
  category: string;
  status: string;
  app_version: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  created_at: string;
  updated_at: string;
  replies: IssueReply[];
  /** 工单主附件 */
  attachments: IssueAttachment[];
}

/** 工单详情响应 */
export interface IssueDetailResponse {
  success: boolean;
  data: IssueDetail;
}

/** 登录状态轮询响应（新方案：返回 proxyToken 而非 accessToken/refreshToken） */
export interface LoginStatusResponse {
  status: "pending" | "completed" | "failed" | "not_found";
  message?: string;
  /** 代理令牌（7 天有效，替代旧 refreshToken） */
  proxyToken?: string;
  /** 代理令牌过期时间（ISO 8601） */
  proxyExpiresAt?: string | null;
  /** 代理令牌剩余有效期（秒） */
  proxyExpiresIn?: number;
  tokenType?: string;
  user?: {
    id: number;
    username: string;
    usergroup: string;
    userimg?: string | null;
    usertoken?: string;
    email?: string | null;
    phone?: string | null;
  };
}

/** 登录完成结果（新方案，供 finishLogin 使用） */
export interface BackendLoginResult {
  proxyToken: string;
  proxyExpiresAt?: string | null;
  proxyExpiresIn?: number;
  tokenType?: string;
  user: {
    id: number;
    username: string;
    usergroup: string;
    userimg?: string | null;
    usertoken?: string;
    email?: string | null;
    phone?: string | null;
  };
}

// ===== 内部工具 =====

const isBrowser = typeof window !== "undefined";

/** 拼接后端完整 URL */
function backendUrl(path: string): string {
  return path.startsWith("/") ? `${BACKEND_API_BASE_URL}${path}` : `${BACKEND_API_BASE_URL}/${path}`;
}

/** 获取当前存储的访问令牌（用于 Bearer 认证） */
function getAccessToken(): string | null {
  if (!isBrowser) return null;
  const user = getStoredUser();
  return user?.accessToken?.trim() || null;
}

/** 获取当前应用版本号 */
async function getAppVersion(): Promise<string | undefined> {
  try {
    return await getVersion();
  } catch {
    return undefined;
  }
}

/** 获取当前平台标识 */
function getPlatform(): string {
  if (typeof navigator === "undefined") return "unknown";
  const ua = navigator.platform.toUpperCase();
  if (ua.indexOf("WIN") >= 0) return "windows";
  if (ua.indexOf("MAC") >= 0) return "macos";
  if (ua.indexOf("LINUX") >= 0) return "linux";
  return navigator.platform || "unknown";
}

/** 统一解析后端 JSON 响应并处理错误 */
export class BackendApiError extends Error {
  readonly code?: string;
  readonly status?: number;
  readonly details?: Record<string, unknown>;

  constructor(
    message: string,
    code?: string,
    status?: number,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "BackendApiError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

async function parseBackendJson<T>(response: Response, fallback: string): Promise<T> {
  const text = await response.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(fallback);
  }

  // 后端统一返回 { success: boolean, message?: string, ... }
  const typed = data as { success?: boolean; message?: string; code?: string } & T;
  const details = typeof data === "object" && data !== null ? data as Record<string, unknown> : undefined;

  if (response.status === 401) {
    throw new BackendApiError("登录信息已过期，请重新登录", typed.code, 401, details);
  }

  if (response.status === 403) {
    throw new BackendApiError(typed.message || "操作被拒绝，请完成验证码校验", typed.code, 403, details);
  }

  if (!response.ok) {
    throw new BackendApiError(typed.message || fallback, typed.code, response.status, details);
  }

  if (typed.success === false) {
    throw new BackendApiError(typed.message || fallback, typed.code, response.status, details);
  }

  return typed;
}

/** 构造带认证的请求头 */
function authHeaders(extra?: Record<string, string | undefined>): Record<string, string> {
  const token = getAccessToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  for (const [key, value] of Object.entries(extra || {})) {
    if (value === undefined) delete headers[key];
    else headers[key] = value;
  }
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

// ===== 登录流程（浏览器 OAuth + 轮询） =====

/**
 * 生成登录会话 ID
 * 用于关联浏览器登录与客户端轮询
 */
export function generateSessionId(): string {
  // 使用 crypto.randomUUID（现代浏览器均支持），回退到时间戳+随机数
  if (isBrowser && typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

/**
 * 构造浏览器登录页 URL
 * 用户在浏览器中完成极验验证码 + qzhua OAuth 授权
 */
export function buildLoginUrl(sessionId: string): string {
  const params = new URLSearchParams({ session: sessionId });
  return backendUrl(`/auth/login?${params.toString()}`);
}

/**
 * 构造登出 URL（浏览器打开后由后端重定向到 qzhua 登出端点）
 */
export function buildLogoutUrl(): string {
  return backendUrl("/auth/logout");
}

/**
 * 轮询登录状态
 * 建议调用方使用 startLoginPolling 封装，避免手动管理定时器
 */
export async function checkLoginStatus(sessionId: string): Promise<LoginStatusResponse> {
  const params = new URLSearchParams({ session: sessionId });
  const res = await fetch(backendUrl(`/auth/status?${params.toString()}`), {
    method: "GET",
    cache: "no-store",
    credentials: "omit",
  });

  return parseBackendJson<LoginStatusResponse>(res, "获取登录状态失败");
}

/**
 * 启动登录轮询，直到状态变为 completed/failed
 *
 * @param sessionId 会话 ID
 * @param options.intervalMs 轮询间隔（默认 2000ms，与后端 OAuth 流程耗时匹配）
 * @param options.timeoutMs 总超时时间（默认 300000ms = 5 分钟），超时后抛出错误
 * @param options.onPending 每次轮询仍处于 pending 时的回调
 * @param options.onTick 每秒触发的倒计时回调，参数为剩余秒数
 * @param options.signal 外部 AbortSignal，用于取消轮询
 * @returns 登录完成结果；失败时抛出错误
 *
 * 注意：
 * 1. not_found 状态在宽限期（60秒）内会继续重试，
 *    因为前端轮询可能先于用户打开浏览器登录页开始，
 *    此时后端尚未创建 session 记录。
 * 2. 超时后会自动终止轮询并抛出 "登录超时" 错误。
 */
export async function startLoginPolling(
  sessionId: string,
  options?: {
    intervalMs?: number;
    timeoutMs?: number;
    onPending?: () => void;
    onTick?: (remainingSeconds: number) => void;
    signal?: AbortSignal;
  },
): Promise<BackendLoginResult> {
  const interval = options?.intervalMs ?? 2000;
  const timeoutMs = options?.timeoutMs ?? 300_000; // 默认 5 分钟
  const signal = options?.signal;
  // session 创建宽限期：用户可能需要几秒到十几秒才打开浏览器页面
  const notFoundGraceMs = 60_000;
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;

  // 倒计时定时器：每秒触发 onTick 回调
  let tickTimer: ReturnType<typeof setInterval> | null = null;
  if (options?.onTick) {
    tickTimer = setInterval(() => {
      const remaining = Math.max(0, Math.floor((deadline - Date.now()) / 1000));
      options.onTick!(remaining);
    }, 1000);
    // 立即触发一次，避免首秒空白
    options.onTick(Math.floor((deadline - Date.now()) / 1000));
  }

  // 清理倒计时定时器
  const cleanupTick = () => {
    if (tickTimer) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
  };

  // 监听外部 abort 信号，清理定时器
  const onAbort = () => cleanupTick();
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    // 轮询直到完成或失败
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (signal?.aborted) {
        throw new Error("登录已取消");
      }

      // 超时检查
      if (Date.now() >= deadline) {
        throw new Error("登录超时，请重新尝试");
      }

      const status = await checkLoginStatus(sessionId);

      if (status.status === "completed") {
        if (!status.proxyToken || !status.user) {
          throw new Error("登录成功但未返回代理令牌");
        }
        return {
          proxyToken: status.proxyToken,
          proxyExpiresAt: status.proxyExpiresAt ?? null,
          proxyExpiresIn: status.proxyExpiresIn,
          tokenType: status.tokenType || "Bearer",
          user: status.user,
        };
      }

      if (status.status === "failed") {
        throw new Error(status.message || "登录失败，请重试");
      }

      if (status.status === "not_found") {
        // 宽限期内继续重试：session 可能尚未创建（用户还没打开浏览器登录页）
        if (Date.now() - startedAt < notFoundGraceMs) {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, interval);
            signal?.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                reject(new Error("登录已取消"));
              },
              { once: true },
            );
          });
          continue;
        }
        throw new Error("登录会话不存在或已过期，请重新登录");
      }

      // pending：通知调用方后等待下一次轮询
      options?.onPending?.();
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, interval);
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new Error("登录已取消"));
          },
          { once: true },
        );
      });
    }
  } finally {
    cleanupTick();
    signal?.removeEventListener("abort", onAbort);
  }
}

// ===== 使用量上报 =====

/**
 * 上报使用量事件
 * 自动附带当前应用版本和平台信息
 */
export async function reportUsage(
  payload: UsageReportPayload,
): Promise<UsageReportResponse> {
  const appVersion = payload.appVersion || (await getAppVersion());
  const platform = payload.platform || getPlatform();
  const eventId = payload.eventId || crypto.randomUUID();
  const sessionId = payload.sessionId || getUsageSessionId();

  const res = await fetch(backendUrl("/api/usage/report"), {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      eventType: payload.eventType,
      eventData: payload.eventData,
      appVersion,
      platform,
      eventId,
      eventVersion: payload.eventVersion || 1,
      sessionId,
      clientTime: payload.clientTime || new Date().toISOString(),
    }),
    cache: "no-store",
    credentials: "omit",
  });

  return parseBackendJson<UsageReportResponse>(res, "使用量上报失败");
}

const usageSessionId = crypto.randomUUID();

function getUsageSessionId(): string {
  return usageSessionId;
}

/**
 * 上报应用启动事件（便捷方法）
 * 建议在应用启动且用户已登录后调用
 */
export async function reportAppLaunch(): Promise<void> {
  try {
    await reportUsage({ eventType: "app_launch" });
  } catch (err) {
    // 使用量上报失败不应影响应用正常使用，仅记录日志
    console.warn("[backendApi] 上报启动事件失败:", err);
  }
}

// ===== 极验验证码 =====

/**
 * 获取极验 GT4 公开配置（captcha_id）
 * 前端使用返回的 captcha_id 调用 initGeetest4 初始化验证码
 */
export async function getGeetestConfig(): Promise<GeetestConfig> {
  const res = await fetch(backendUrl("/auth/captcha/config"), {
    method: "GET",
    cache: "no-store",
    credentials: "omit",
  });

  return parseBackendJson<GeetestConfig>(res, "获取验证码配置失败");
}

// ===== 工单 =====

/**
 * 通过 XMLHttpRequest 上传 FormData，支持上传进度回调。
 * 错误语义与 parseBackendJson 保持一致，统一抛出 BackendApiError。
 */
function uploadFormData<T>(
  url: string,
  formData: FormData,
  fallback: string,
  onUploadProgress?: (percent: number) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);

    // 与 authHeaders({ "Content-Type": undefined }) 一致：
    // multipart 边界由浏览器自动生成，不能手动设置 Content-Type
    const headers = authHeaders();
    delete headers["Content-Type"];
    for (const [key, value] of Object.entries(headers)) {
      xhr.setRequestHeader(key, value);
    }

    if (onUploadProgress) {
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable && event.total > 0) {
          onUploadProgress(Math.min(100, Math.round((event.loaded / event.total) * 100)));
        }
      };
      // 发送开始即回调 0，让界面立即进入"上传中"状态
      onUploadProgress(0);
    }

    xhr.onload = () => {
      let data: unknown;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        reject(new BackendApiError(fallback, undefined, xhr.status));
        return;
      }
      const typed = data as { success?: boolean; message?: string; code?: string } & T;
      const details = typeof data === "object" && data !== null ? (data as Record<string, unknown>) : undefined;

      if (xhr.status === 401) {
        reject(new BackendApiError("登录信息已过期，请重新登录", typed.code, 401, details));
        return;
      }
      if (xhr.status === 403) {
        reject(new BackendApiError(typed.message || "操作被拒绝，请完成验证码校验", typed.code, 403, details));
        return;
      }
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new BackendApiError(typed.message || fallback, typed.code, xhr.status, details));
        return;
      }
      if (typed.success === false) {
        reject(new BackendApiError(typed.message || fallback, typed.code, xhr.status, details));
        return;
      }
      resolve(typed);
    };
    xhr.onerror = () => reject(new BackendApiError("网络错误，上传失败", undefined, 0));
    xhr.onabort = () => reject(new BackendApiError("上传已取消", undefined, 0));

    xhr.send(formData);
  });
}

/**
 * 提交工单
 * 需要极验验证码校验结果（后端强制要求）
 * @param onUploadProgress 上传进度回调（0-100），用于附件上传进度条
 */
export async function submitIssue(
  payload: IssueSubmitPayload,
  geetest: GeetestValidation,
  onUploadProgress?: (percent: number) => void,
): Promise<IssueSubmitResponse> {
  const appVersion = payload.appVersion || (await getAppVersion());
  const platform = payload.platform || getPlatform();
  const formData = new FormData();
  formData.append("title", payload.title);
  formData.append("description", payload.description);
  formData.append("category", payload.category || "other");
  formData.append("appVersion", appVersion || "");
  formData.append("platform", platform);
  formData.append("contactEmail", payload.contactEmail?.trim() || "");
  formData.append("contactPhone", payload.contactPhone?.trim() || "");
  formData.append("captcha", JSON.stringify({
    lot_number: geetest.lot_number,
    captcha_output: geetest.captcha_output,
    pass_token: geetest.pass_token,
    gen_time: geetest.gen_time,
  }));
  payload.attachments?.forEach((file) => formData.append("attachments", file, file.name));

  return uploadFormData<IssueSubmitResponse>(
    backendUrl("/api/issues/submit"),
    formData,
    "工单提交失败",
    onUploadProgress,
  );
}

export async function getIssueSubmitPermission(): Promise<IssueSubmitPermission> {
  const res = await fetch(backendUrl("/api/issues/submit-permission"), {
    method: "GET",
    headers: authHeaders(),
    cache: "no-store",
    credentials: "omit",
  });
  return parseBackendJson<IssueSubmitPermission>(res, "获取工单提交资格失败");
}

/**
 * 获取当前用户提交的工单列表
 */
export async function listIssues(
  options?: { page?: number; pageSize?: number },
): Promise<IssueListResponse> {
  const page = options?.page ?? 1;
  const pageSize = options?.pageSize ?? 20;
  const params = new URLSearchParams({
    page: String(page),
    pageSize: String(pageSize),
  });

  const res = await fetch(backendUrl(`/api/issues/list?${params.toString()}`), {
    method: "GET",
    headers: authHeaders(),
    cache: "no-store",
    credentials: "omit",
  });

  return parseBackendJson<IssueListResponse>(res, "获取工单列表失败");
}

/**
 * 获取工单详情（含所有回复）
 */
export async function getIssueDetail(issueId: number): Promise<IssueDetailResponse> {
  const res = await fetch(backendUrl(`/api/issues/${issueId}`), {
    method: "GET",
    headers: authHeaders(),
    cache: "no-store",
    credentials: "omit",
  });

  return parseBackendJson<IssueDetailResponse>(res, "获取工单详情失败");
}

/** 工单回复响应 */
export interface IssueReplyResponse {
  success: boolean;
  message?: string;
}

/**
 * 用户回复工单（支持附件）
 * @param issueId 工单 ID
 * @param content 回复内容
 * @param files 回复附件（最多 3 个）
 * @param onUploadProgress 附件上传进度回调（0-100，仅带附件时触发）
 */
export async function replyIssue(
  issueId: number,
  content: string,
  files: File[] = [],
  onUploadProgress?: (percent: number) => void,
): Promise<IssueReplyResponse> {
  if (files.length > 0) {
    const formData = new FormData();
    formData.append("content", content);
    files.forEach((file) => formData.append("attachments", file, file.name));
    return uploadFormData<IssueReplyResponse>(
      backendUrl(`/api/issues/${issueId}/reply`),
      formData,
      "回复工单失败",
      onUploadProgress,
    );
  }
  const res = await fetch(backendUrl(`/api/issues/${issueId}/reply`), {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
    cache: "no-store",
    credentials: "omit",
  });

  return parseBackendJson<IssueReplyResponse>(res, "回复工单失败");
}

/** 附件预览 URL 响应 */
export interface AttachmentPreviewResponse {
  success: boolean;
  /** 完整预览地址（短期签名，10 分钟有效） */
  url: string;
  mimeType: string;
}

/**
 * 获取附件在线预览地址（短期签名 URL，img/video 标签可直接引用）
 */
export async function getAttachmentPreviewUrl(
  issueId: number,
  attachmentId: number,
): Promise<AttachmentPreviewResponse> {
  const res = await fetch(
    backendUrl(`/api/issues/${issueId}/attachments/${attachmentId}/preview-url`),
    {
      method: "GET",
      headers: authHeaders(),
      cache: "no-store",
      credentials: "omit",
    },
  );
  const data = await parseBackendJson<AttachmentPreviewResponse>(res, "获取附件预览失败");
  // 后端返回相对路径，拼接为完整地址
  return { ...data, url: backendUrl(data.url) };
}

// ===== 便捷工具 =====

/**
 * 判断当前是否有可用的访问令牌
 * 用于决定是否可以调用需要认证的后端接口
 */
export function isBackendAuthenticated(): boolean {
  return getAccessToken() !== null;
}

/**
 * 获取当前登录用户（便捷封装）
 */
export function getCurrentUser(): StoredUser | null {
  return getStoredUser();
}
