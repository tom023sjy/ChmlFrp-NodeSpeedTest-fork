import {
  CHMLFRP_API_BASE_URL,
  BACKEND_API_BASE_URL,
} from "@/lib/api-endpoints";
import { invoke } from "@tauri-apps/api/core";

const API_BASE_URL = CHMLFRP_API_BASE_URL;

export interface StoredUser {
  username: string;
  usergroup: string;
  userimg?: string | null;
  usertoken?: string;
  /** qzhua 真实 access_token（30 分钟有效期，过期自动通过 proxyToken 刷新） */
  accessToken?: string;
  /** access_token 过期时间戳（毫秒） */
  accessTokenExpiresAt?: number;
  tokenType?: string;
  /** 后端代理令牌（7 天有效期，替代旧 refreshToken，由后端托管 qzhua refresh_token） */
  proxyToken?: string;
  /** 代理令牌过期时间（ISO 8601 字符串） */
  proxyExpiresAt?: string | null;
  tunnelCount?: number;
  tunnel?: number;
  /** 用户邮箱（来自 ChmlFrp 账号信息，用于工单联系方式预填） */
  email?: string | null;
  /** 用户手机号（暂无自动获取来源，由用户在工单中手填） */
  phone?: string | null;
}

export interface UserInfo {
  id: number;
  username: string;
  password: string | null;
  userimg: string;
  qq: string;
  email: string;
  usertoken: string;
  usergroup: string;
  bandwidth: number;
  tunnel: number;
  realname: string;
  integral: number;
  term: string;
  scgm: string;
  regtime: string;
  realname_count: number | null;
  total_download: number | null;
  total_upload: number | null;
  tunnelCount: number;
  totalCurConns: number;
}

export interface Tunnel {
  id: number;
  name: string;
  localip: string;
  type: string;
  nport: number;
  dorp: string;
  node: string;
  ap: string;
  uptime: string | null;
  client_version: string | null;
  today_traffic_in: number | null;
  today_traffic_out: number | null;
  cur_conns: number | null;
  nodestate: string;
  ip: string;
  node_ip: string;
  node_ipv6: string | null;
  server_port: number;
  remote_port?: number;
  node_token: string;
}

export interface FlowPoint {
  traffic_in: number;
  traffic_out: number;
  time: string;
}

export interface SignInInfo {
  is_signed_in_today: boolean;
  total_points: number;
  count_of_matching_records: number;
  total_sign_ins: number;
  last_sign_in_time: string;
}

interface ApiResponse<T> {
  code: number;
  msg?: string;
  data?: T;
}

const isBrowser = typeof window !== "undefined";
const NODE_UDP_CACHE_KEY = "node_udp_cache";
const NODE_UDP_CACHE_TTL = 5 * 60 * 1000;

// 简单的请求去重（针对短时间内重复发起相同请求的场景）
const pendingRequests = new Map<string, Promise<unknown>>();

function normalizeHeaders(h?: HeadersInit): Record<string, string> {
  if (!h) return {};
  if (h instanceof Headers) {
    const obj: Record<string, string> = {};
    h.forEach((v, k) => (obj[k] = v));
    return obj;
  }
  if (Array.isArray(h)) {
    const obj: Record<string, string> = {};
    h.forEach(([k, v]) => (obj[k] = v));
    return obj;
  }
  return h as Record<string, string>;
}

function getBypassProxy(): boolean {
  if (!isBrowser) return true;
  const stored = localStorage.getItem("bypassProxy");
  return stored !== "false";
}

function getRequestUrl(endpoint: string): string {
  return endpoint.startsWith("/")
    ? `${API_BASE_URL}${endpoint}`
    : `${API_BASE_URL}/${endpoint}`;
}

function normalizeStoredUser(user: StoredUser | null): StoredUser | null {
  if (!user) {
    return null;
  }
  const normalized: StoredUser = { ...user };
  if (normalized.accessTokenExpiresAt != null) {
    const expiresAt = Number(normalized.accessTokenExpiresAt);
    normalized.accessTokenExpiresAt = Number.isFinite(expiresAt)
      ? expiresAt
      : undefined;
  }
  return normalized;
}

function getLegacyApiToken(user: StoredUser | null): string | undefined {
  if (!user?.usertoken) {
    return undefined;
  }
  if (user.accessToken && user.usertoken === user.accessToken) {
    return undefined;
  }
  return user.usertoken;
}

function getCurrentAccessToken(user: StoredUser | null): string | undefined {
  if (user?.accessToken?.trim()) {
    return user.accessToken.trim();
  }
  return undefined;
}

// access_token 有效期通常 30 分钟，提前 60 秒刷新确保有足够窗口
const TOKEN_REFRESH_LEAD_MS = 60_000;

// 后端未返回 expiresIn 时，保守默认 access_token 25 分钟过期
const DEFAULT_ACCESS_TOKEN_TTL_MS = 25 * 60 * 1000;

function isAccessTokenExpiring(user: StoredUser | null): boolean {
  const expiresAt = user?.accessTokenExpiresAt;
  if (!expiresAt) {
    return false;
  }
  return Date.now() >= expiresAt - TOKEN_REFRESH_LEAD_MS;
}

/** 检查代理令牌是否已过期（7 天有效期） */
function isProxyTokenExpired(user: StoredUser | null): boolean {
  if (!user?.proxyExpiresAt) {
    return false;
  }
  const expiresAt = new Date(user.proxyExpiresAt).getTime();
  if (!Number.isFinite(expiresAt)) {
    return false;
  }
  return Date.now() >= expiresAt;
}

function toBearerHeader(token: string): string {
  return token.startsWith("Bearer ") ? token : `Bearer ${token}`;
}

// ===== 代理令牌刷新（调后端 /auth/refresh，后端内部托管 qzhua refresh_token） =====

/** 后端 /auth/refresh 成功响应 */
interface ProxyRefreshResponse {
  success: boolean;
  accessToken: string;
  expiresIn: number;
  tokenType: string;
  proxyExpiresIn: number;
}

/** 后端 /auth/refresh 失败响应 */
interface ProxyRefreshError {
  code: string;
  message?: string;
}

/** 代理令牌刷新错误（携带错误码，便于调用方区分「需重新登录」vs「临时故障」） */
export class ProxyTokenError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ProxyTokenError";
    this.code = code;
  }
}

// 单例锁：并发调用复用同一刷新 Promise，避免重复请求触发后端速率限制（每分钟 5 次）
let refreshingPromise: Promise<ProxyRefreshResponse> | null = null;

/**
 * 用代理令牌换 access_token
 *
 * 后端有缓存优化：若当前 access_token 还剩超过 60 秒有效期，直接返回缓存值，
 * 不会真的调 qzhua。所以可以放心频繁调用。
 *
 * 失败处理：
 * - PROXY_TOKEN_INVALID / REFRESH_TOKEN_EXPIRED：需清空登录态，跳转登录页
 * - RATE_LIMITED：退避后重试
 * - REFRESH_FAILED：后端临时故障，保留登录态退避重试
 */
async function refreshAccessTokenViaProxy(proxyToken: string): Promise<ProxyRefreshResponse> {
  if (refreshingPromise) {
    return refreshingPromise;
  }

  refreshingPromise = (async () => {
    const response = await fetch(`${BACKEND_API_BASE_URL}/auth/refresh`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${proxyToken}`,
      },
      cache: "no-store",
      credentials: "omit",
    });

    if (!response.ok) {
      let errBody: ProxyRefreshError = { code: "UNKNOWN" };
      try {
        errBody = await response.json();
      } catch {
        // 响应非 JSON，使用默认错误
      }
      const code = errBody.code || "UNKNOWN";
      const msg = errBody.message || `代理令牌刷新失败 (HTTP ${response.status})`;
      console.error(`[auth] /auth/refresh 失败 HTTP ${response.status}:`, errBody);
      throw new ProxyTokenError(code, msg);
    }

    const data = await response.json() as ProxyRefreshResponse;
    if (!data.success || !data.accessToken) {
      throw new ProxyTokenError("UNKNOWN", "代理令牌刷新返回异常");
    }

    console.log("[auth] /auth/refresh 成功，新 access_token 前 8 位:",
      data.accessToken.slice(0, 8), "expiresIn:", data.expiresIn,
      "proxyExpiresIn:", data.proxyExpiresIn);

    // 同步更新内存缓存中的 accessToken，异步持久化到加密数据库
    if (cachedUser) {
      const updatedUser: StoredUser = {
        ...cachedUser,
        accessToken: data.accessToken,
        accessTokenExpiresAt: data.expiresIn
          ? Date.now() + data.expiresIn * 1000
          : Date.now() + DEFAULT_ACCESS_TOKEN_TTL_MS,
        tokenType: data.tokenType || cachedUser.tokenType || "Bearer",
      };
      cachedUser = updatedUser;
      invoke("secure_store", {
        key: SECURE_USER_KEY,
        value: JSON.stringify(updatedUser),
      }).catch((err) => {
        console.error("[secureStorage] 保存刷新后的用户数据失败:", err);
        localStorage.setItem("chmlfrp_user", JSON.stringify(updatedUser));
      });
    }

    return data;
  })();

  try {
    return await refreshingPromise;
  } finally {
    refreshingPromise = null;
  }
}

async function ensureAuthenticatedUser(
  explicitToken?: string,
): Promise<{
  storedUser: StoredUser | null;
  accessToken?: string;
  legacyToken?: string;
}> {
  if (explicitToken?.trim()) {
    return {
      storedUser: getStoredUser(),
      accessToken: explicitToken.trim(),
    };
  }

  const storedUser = getStoredUser();
  if (!storedUser) {
    throw new Error("登录信息已过期，请重新登录");
  }

  // 代理令牌已过期（7 天到期），必须重新登录
  if (isProxyTokenExpired(storedUser)) {
    clearStoredUser();
    throw new ProxyTokenError("PROXY_TOKEN_INVALID", "代理令牌已过期，请重新登录");
  }

  const currentAccessToken = getCurrentAccessToken(storedUser);
  if (currentAccessToken) {
    // access_token 即将过期且有 proxyToken，主动刷新
    if (storedUser.proxyToken && isAccessTokenExpiring(storedUser)) {
      try {
        await refreshAccessTokenViaProxy(storedUser.proxyToken);
        const updatedUser = getStoredUser();
        if (updatedUser?.accessToken) {
          return {
            storedUser: updatedUser,
            accessToken: updatedUser.accessToken,
            legacyToken: getLegacyApiToken(updatedUser),
          };
        }
      } catch (refreshErr) {
        if (refreshErr instanceof ProxyTokenError) {
          // PROXY_TOKEN_INVALID / REFRESH_TOKEN_EXPIRED：必须重新登录
          if (
            refreshErr.code === "PROXY_TOKEN_INVALID" ||
            refreshErr.code === "REFRESH_TOKEN_EXPIRED"
          ) {
            clearStoredUser();
            throw refreshErr;
          }
          // RATE_LIMITED / REFRESH_FAILED / UNKNOWN：降级用旧 token 尝试
          console.warn(`[auth] /auth/refresh 暂时失败 (${refreshErr.code})，降级使用旧 access_token`);
        } else {
          console.warn("[auth] /auth/refresh 网络异常，降级使用旧 access_token:", refreshErr);
        }
      }
    }

    return {
      storedUser,
      accessToken: currentAccessToken,
      legacyToken: getLegacyApiToken(storedUser),
    };
  }

  // 无 accessToken 但有 proxyToken，立即刷新
  if (storedUser.proxyToken) {
    try {
      await refreshAccessTokenViaProxy(storedUser.proxyToken);
      const updatedUser = getStoredUser();
      if (updatedUser?.accessToken) {
        return {
          storedUser: updatedUser,
          accessToken: updatedUser.accessToken,
          legacyToken: getLegacyApiToken(updatedUser),
        };
      }
    } catch (refreshErr) {
      if (refreshErr instanceof ProxyTokenError) {
        if (
          refreshErr.code === "PROXY_TOKEN_INVALID" ||
          refreshErr.code === "REFRESH_TOKEN_EXPIRED"
        ) {
          clearStoredUser();
          throw refreshErr;
        }
      }
      throw refreshErr;
    }
  }

  const legacyToken = getLegacyApiToken(storedUser);
  if (legacyToken) {
    return {
      storedUser,
      legacyToken,
    };
  }

  clearStoredUser();
  throw new Error("登录信息已过期，请重新登录");
}

async function request<T>(endpoint: string, options?: RequestInit): Promise<T> {
  const headersObj = normalizeHeaders(options?.headers);
  const key = JSON.stringify({
    endpoint,
    method: options?.method ?? "GET",
    body: options?.body ?? null,
    headers: headersObj,
  });

  if (pendingRequests.has(key)) {
    return pendingRequests.get(key) as Promise<T>;
  }

  const promise = (async () => {
    try {
      const url = getRequestUrl(endpoint);

      const bypassProxy = getBypassProxy();

      // 在 Tauri 环境中，如果启用绕过代理，使用 Tauri 命令
      if (
        typeof window !== "undefined" &&
        "__TAURI__" in window &&
        bypassProxy
      ) {
        const { invoke } = await import("@tauri-apps/api/core");
        const method = (options?.method ?? "GET").toUpperCase();
        const headers: Record<string, string> = {};

        if (headersObj) {
          Object.entries(headersObj).forEach(([k, v]) => {
            headers[k] = v;
          });
        }

        const body = options?.body ? String(options.body) : undefined;

        const responseText = await invoke<string>("http_request", {
          options: {
            url,
            method,
            headers: Object.keys(headers).length > 0 ? headers : undefined,
            body,
            bypass_proxy: true,
          },
        });

        const data = JSON.parse(responseText) as ApiResponse<T>;
        if (data?.code === 200) {
          return data.data as T;
        }
        throw new Error(data?.msg || "请求失败");
      } else {
        // 使用普通的 fetch
        const res = await fetch(url, options);
        const data = (await res.json()) as ApiResponse<T>;
        if (data?.code === 200) {
          return data.data as T;
        }
        throw new Error(data?.msg || "请求失败");
      }
    } finally {
      pendingRequests.delete(key);
    }
  })();

  pendingRequests.set(key, promise);
  return promise;
}

// ===== 安全存储（加密数据库替代 localStorage） =====

/** 内存缓存，供同步读取 */
let cachedUser: StoredUser | null = null;

/** 安全存储 key */
const SECURE_USER_KEY = "chmlfrp_user";

/** 初始化安全存储：从加密数据库加载用户数据到内存缓存
 *  应用启动时调用一次。包含从旧 localStorage 自动迁移逻辑。
 *  返回 true 表示有已登录用户。
 */
let initPromise: Promise<boolean> | null = null;

export function initSecureStorage(): Promise<boolean> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    if (!isBrowser) return false;
    try {
      // 1. 从加密数据库加载
      const encrypted = await invoke<string>("secure_load", {
        key: SECURE_USER_KEY,
      });
      if (encrypted) {
        const user = normalizeStoredUser(JSON.parse(encrypted) as StoredUser);
        // 检查代理令牌是否已过期（7 天到期则需重新登录）
        if (user && isProxyTokenExpired(user)) {
          console.log("[secureStorage] 代理令牌已过期，清除登录态");
          cachedUser = null;
          await invoke("secure_delete", { key: SECURE_USER_KEY }).catch(() => {});
          return false;
        }
        // 旧版本数据（有 refreshToken 但无 proxyToken）无法续期，清除
        if (user && !user.proxyToken) {
          console.log("[secureStorage] 旧版本登录态无 proxyToken，清除");
          cachedUser = null;
          await invoke("secure_delete", { key: SECURE_USER_KEY }).catch(() => {});
          return false;
        }
        cachedUser = user;
        return true;
      }
      // 2. 数据库为空时检查 localStorage（极旧版本数据迁移）
      const legacy = localStorage.getItem("chmlfrp_user");
      if (legacy) {
        const user = normalizeStoredUser(JSON.parse(legacy) as StoredUser);
        // 旧版本数据无 proxyToken，直接清除并提示重新登录
        if (!user?.proxyToken) {
          console.log("[secureStorage] localStorage 旧版本数据无 proxyToken，清除");
          localStorage.removeItem("chmlfrp_user");
          return false;
        }
        cachedUser = user;
        await invoke("secure_store", {
          key: SECURE_USER_KEY,
          value: JSON.stringify(user),
        });
        localStorage.removeItem("chmlfrp_user");
        return true;
      }
    } catch (err) {
      console.warn("[secureStorage] 初始化失败，降级到 localStorage:", err);
      const legacy = localStorage.getItem("chmlfrp_user");
      if (legacy) {
        const user = normalizeStoredUser(JSON.parse(legacy) as StoredUser);
        if (user?.proxyToken && !isProxyTokenExpired(user)) {
          cachedUser = user;
          return true;
        }
      }
    }
    return false;
  })();
  return initPromise;
}

export const getStoredUser = (): StoredUser | null => {
  if (!isBrowser) return null;
  return cachedUser;
};

export const saveStoredUser = (user: StoredUser) => {
  if (!isBrowser) return;
  const normalized = normalizeStoredUser(user);
  cachedUser = normalized;
  // 异步写入加密数据库（不阻塞 UI）
  invoke("secure_store", {
    key: SECURE_USER_KEY,
    value: JSON.stringify(normalized),
  }).catch((err) => {
    console.error("[secureStorage] 保存用户数据失败:", err);
    // 降级：写入 localStorage
    localStorage.setItem("chmlfrp_user", JSON.stringify(normalized));
  });
};

export const clearStoredUser = () => {
  if (!isBrowser) return;
  cachedUser = null;
  // 异步从加密数据库删除
  invoke("secure_delete", { key: SECURE_USER_KEY }).catch((err) => {
    console.error("[secureStorage] 删除用户数据失败:", err);
  });
  // 同时清除 localStorage（兼容降级场景）
  localStorage.removeItem("chmlfrp_user");
};

/**
 * 用代理令牌完成登录
 *
 * 后端 /auth/status 返回 proxyToken 后，软件端调用此方法：
 * 1. 用 proxyToken 调后端 /auth/refresh 获取首个 accessToken
 * 2. 调 ChmlFrp /userinfo 获取用户信息
 * 3. 组装 StoredUser 并返回
 *
 * @param proxyToken 后端下发的代理令牌（64 位 hex，7 天有效）
 * @param user 后端 /auth/status 返回的 user 对象
 * @param proxyExpiresAt 代理令牌过期时间（ISO 8601）
 */
export async function loginWithProxyToken(
  proxyToken: string,
  user: {
    username: string;
    usergroup: string;
    userimg?: string | null;
    usertoken?: string;
    email?: string | null;
    phone?: string | null;
  },
  proxyExpiresAt?: string | null,
): Promise<StoredUser> {
  console.log("[auth] 代理令牌登录，proxyToken 前 8 位:", proxyToken.slice(0, 8));

  // 1. 用 proxyToken 换 accessToken
  const refreshResult = await refreshAccessTokenViaProxy(proxyToken);

  // 2. 组装用户信息（后端 /auth/status 已返回 user，无需再调 /userinfo）
  //    但 user.usertoken 可能与 accessToken 不同，保留后端返回的 usertoken
  const storedUser: StoredUser = {
    username: user.username,
    usergroup: user.usergroup,
    userimg: user.userimg,
    usertoken: user.usertoken,
    accessToken: refreshResult.accessToken,
    accessTokenExpiresAt: refreshResult.expiresIn
      ? Date.now() + refreshResult.expiresIn * 1000
      : Date.now() + DEFAULT_ACCESS_TOKEN_TTL_MS,
    tokenType: refreshResult.tokenType || "Bearer",
    proxyToken,
    proxyExpiresAt: proxyExpiresAt ?? null,
    email: user.email ?? null,
    phone: user.phone ?? null,
  };

  console.log("[auth] 代理令牌登录成功，username:", storedUser.username,
    "accessToken 前 8 位:", storedUser.accessToken?.slice(0, 8));

  return storedUser;
}

/**
 * 退出登录：吊销代理令牌并清除本地登录态
 *
 * 调用后端 /auth/revoke 使 proxyToken 立即失效，然后清除本地存储。
 * 即使后端吊销失败（网络错误等），也会清除本地登录态，确保用户能退出。
 */
export async function logoutWithProxyToken(): Promise<void> {
  const user = getStoredUser();
  if (user?.proxyToken) {
    try {
      await fetch(`${BACKEND_API_BASE_URL}/auth/revoke`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${user.proxyToken}`,
        },
        cache: "no-store",
        credentials: "omit",
      });
      console.log("[auth] 代理令牌已吊销");
    } catch (err) {
      console.warn("[auth] 吊销代理令牌失败（仍会清除本地登录态）:", err);
    }
  }
  clearStoredUser();
}

export async function fetchTunnels(token?: string): Promise<Tunnel[]> {
  const { accessToken, legacyToken } = await ensureAuthenticatedUser(token);
  const authorization = accessToken
    ? toBearerHeader(accessToken)
    : toBearerHeader(legacyToken!);

  const data = await request<Tunnel[]>("/tunnel", {
    headers: { authorization },
  });

  if (Array.isArray(data)) return data;
  throw new Error("获取隧道列表失败");
}

export async function fetchFlowLast7Days(token?: string): Promise<FlowPoint[]> {
  const { accessToken, legacyToken } = await ensureAuthenticatedUser(token);
  const authorization = accessToken
    ? toBearerHeader(accessToken)
    : toBearerHeader(legacyToken!);

  const data = await request<FlowPoint[]>("/flow_last_7_days", {
    headers: { authorization },
  });

  if (Array.isArray(data)) return data;
  throw new Error("获取近7日流量失败");
}

export async function fetchUserInfo(token?: string): Promise<UserInfo> {
  const { accessToken, legacyToken } = await ensureAuthenticatedUser(token);
  const authorization = accessToken
    ? toBearerHeader(accessToken)
    : toBearerHeader(legacyToken!);

  const data = await request<UserInfo>("/userinfo", {
    headers: { authorization },
  });

  if (data) return data as UserInfo;
  throw new Error("获取用户信息失败");
}

export async function fetchSignInInfo(token?: string): Promise<SignInInfo> {
  const { accessToken, legacyToken } = await ensureAuthenticatedUser(token);
  const authorization = accessToken
    ? toBearerHeader(accessToken)
    : toBearerHeader(legacyToken!);

  const data = await request<SignInInfo>("/qiandao_info", {
    headers: { authorization },
  });

  if (data) return data;
  throw new Error("获取签到信息失败");
}

interface OfflineTunnelResponse {
  code: number;
  state: string;
  msg?: string;
}

export async function offlineTunnel(
  tunnelName: string,
  token?: string,
): Promise<void> {
  const { accessToken, legacyToken } = await ensureAuthenticatedUser(token);
  const authorization = accessToken
    ? toBearerHeader(accessToken)
    : toBearerHeader(legacyToken!);

  const formData = new URLSearchParams();
  formData.append("tunnel_name", tunnelName);

  const endpoint = "/offline_tunnel";
  const headersObj = {
    "Content-Type": "application/x-www-form-urlencoded",
    authorization,
  };

  const bypassProxy = getBypassProxy();

  // 在 Tauri 环境中，如果启用绕过代理，使用 Tauri 命令
  if (typeof window !== "undefined" && "__TAURI__" in window && bypassProxy) {
    const { invoke } = await import("@tauri-apps/api/core");
    const url = endpoint.startsWith("/")
      ? `${API_BASE_URL}${endpoint}`
      : `${API_BASE_URL}/${endpoint}`;

    const responseText = await invoke<string>("http_request", {
      options: {
        url,
        method: "POST",
        headers: headersObj,
        body: formData.toString(),
        bypass_proxy: true,
      },
    });

    const data = JSON.parse(responseText) as OfflineTunnelResponse;
    if (data?.code === 200 && data?.state === "success") {
      return;
    }
    throw new Error(data?.msg || "下线隧道失败");
  } else {
    // 使用普通的 fetch
    const url = endpoint.startsWith("/")
      ? `${API_BASE_URL}${endpoint}`
      : `${API_BASE_URL}/${endpoint}`;

    const res = await fetch(url, {
      method: "POST",
      headers: headersObj,
      body: formData.toString(),
    });

    if (!res.ok) {
      throw new Error(`HTTP错误: ${res.status}`);
    }

    const data = (await res.json()) as OfflineTunnelResponse;
    if (data?.code === 200 && data?.state === "success") {
      return;
    }
    throw new Error(data?.msg || "下线隧道失败");
  }
}

export async function deleteTunnel(
  tunnelId: number,
  token?: string,
): Promise<void> {
  const { accessToken, legacyToken } = await ensureAuthenticatedUser(token);
  const authorization = accessToken
    ? toBearerHeader(accessToken)
    : toBearerHeader(legacyToken!);

  await request<unknown>(`/delete_tunnel?tunnelid=${tunnelId}`, {
    headers: { authorization },
  });
}

export interface Node {
  id: number;
  name: string;
  area: string;
  nodegroup: string;
  china: string;
  web: string;
  udp: string;
  fangyu: string;
  notes: string;
}

interface NodeUdpCache {
  updatedAt: number;
  nodes: Record<string, boolean>;
}

function readNodeUdpCache(): NodeUdpCache | null {
  if (!isBrowser) return null;
  const raw = localStorage.getItem(NODE_UDP_CACHE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as NodeUdpCache;
    if (!parsed || typeof parsed.updatedAt !== "number" || !parsed.nodes) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeNodeUdpCache(cache: NodeUdpCache) {
  if (!isBrowser) return;
  localStorage.setItem(NODE_UDP_CACHE_KEY, JSON.stringify(cache));
}

function isNodeUdpCacheExpired(cache: NodeUdpCache): boolean {
  return Date.now() - cache.updatedAt > NODE_UDP_CACHE_TTL;
}

export interface NodeInfo {
  id: number;
  name: string;
  area: string;
  nodegroup: string;
  china: string;
  web: string;
  udp: string;
  fangyu: string;
  notes: string;
  ip: string;
  port: number;
  adminPort: number;
  rport: string;
  state: string;
  auth: string;
  apitoken: string;
  nodetoken: string;
  real_IP: string;
  realIp: string;
  ipv6: string | null;
  coordinates: string;
  version: string;
  load1: number;
  load5: number;
  load15: number;
  bandwidth_usage_percent: number;
  totalTrafficIn: number;
  totalTrafficOut: number;
  uptime_seconds: number | null;
  cpu_info: string | null;
  num_cores: number | null;
  memory_total: number | null;
  storage_total: number | null;
  storage_used: number | null;
  toowhite: boolean;
}

export interface CreateTunnelParams {
  tunnelname: string;
  node: string;
  localip: string;
  porttype: string;
  localport: number;
  encryption: boolean;
  compression: boolean;
  extraparams: string;
  remoteport?: number;
  banddomain?: string;
}

export interface UpdateTunnelParams {
  tunnelid: number;
  tunnelname: string;
  node: string;
  localip: string;
  porttype: string;
  localport: number;
  encryption: boolean;
  compression: boolean;
  extraparams: string;
  remoteport?: number;
  banddomain?: string;
}

export async function fetchNodes(token?: string): Promise<Node[]> {
  const { accessToken, legacyToken } = await ensureAuthenticatedUser(token);
  const authorization = accessToken
    ? toBearerHeader(accessToken)
    : toBearerHeader(legacyToken!);

  const data = await request<Node[]>("/node", {
    headers: { authorization },
  });

  if (Array.isArray(data)) return data;
  throw new Error("获取节点列表失败");
}

export async function getNodeUdpSupport(
  nodeName: string,
  token?: string,
): Promise<boolean | null> {
  const cache = readNodeUdpCache();
  if (cache && !isNodeUdpCacheExpired(cache) && nodeName in cache.nodes) {
    return cache.nodes[nodeName];
  }

  try {
    const nodes = await fetchNodes(token);
    const nodesMap: Record<string, boolean> = {};
    nodes.forEach((node) => {
      nodesMap[node.name] = node.udp === "true";
    });
    writeNodeUdpCache({ updatedAt: Date.now(), nodes: nodesMap });
    if (nodeName in nodesMap) {
      return nodesMap[nodeName];
    }
    return null;
  } catch {
    return null;
  }
}

export async function fetchNodeInfo(
  nodeName: string,
  token?: string,
): Promise<NodeInfo> {
  const { accessToken, legacyToken } = await ensureAuthenticatedUser(token);
  const authorization = accessToken
    ? toBearerHeader(accessToken)
    : toBearerHeader(legacyToken!);

  const data = await request<NodeInfo>(
    `/nodeinfo?node=${encodeURIComponent(nodeName)}`,
    {
      headers: { authorization },
    },
  );

  if (data) return data;
  throw new Error("获取节点信息失败");
}

export async function createTunnel(
  params: CreateTunnelParams,
  token?: string,
): Promise<void> {
  const { accessToken, legacyToken } = await ensureAuthenticatedUser(token);
  const authorization = accessToken
    ? toBearerHeader(accessToken)
    : toBearerHeader(legacyToken!);

  await request<unknown>("/create_tunnel", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      authorization,
    },
    body: JSON.stringify(params),
  });
}

export async function updateTunnel(
  params: UpdateTunnelParams,
  token?: string,
): Promise<void> {
  const { accessToken, legacyToken } = await ensureAuthenticatedUser(token);
  const authorization = accessToken
    ? toBearerHeader(accessToken)
    : toBearerHeader(legacyToken!);

  await request<unknown>("/update_tunnel", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      authorization,
    },
    body: JSON.stringify(params),
  });
}
