/**
 * 设备互联 REST API 封装
 *
 * 对接后端设备管理接口（列表、重命名、解绑）。
 * WebSocket 中继相关逻辑见 deviceRelay.ts。
 * 鉴权复用 proxyToken / accessToken（Bearer）。
 */
import { BACKEND_API_BASE_URL } from "@/lib/api-endpoints";
import { getStoredUser } from "@/services/api";
import { getDeviceId } from "@/services/deviceId";

// ===== 类型定义 =====

export type DeviceType = "desktop" | "daemon";

export interface DeviceInfo {
  deviceId: string;
  userId?: number;
  deviceName: string;
  deviceType: DeviceType;
  osInfo: string;
  hostname: string;
  interconnectEnabled: boolean;
  isOnline: boolean;
  isCurrent: boolean;
  lastSeenAt: string;
  createdAt: string;
}

// ===== 内部工具 =====

const isBrowser = typeof window !== "undefined";

function backendUrl(path: string): string {
  return path.startsWith("/") ? `${BACKEND_API_BASE_URL}${path}` : `${BACKEND_API_BASE_URL}/${path}`;
}

/** 获取当前存储的代理令牌（用于设备互联 API Bearer 认证）
 *
 * 设备互联 REST/WebSocket 接口使用 proxyToken 鉴权（7 天有效期），
 * 而非 accessToken（qzhua 短期令牌，25 分钟，后端无法直接验证）。
 */
function getProxyToken(): string | null {
  if (!isBrowser) return null;
  const user = getStoredUser();
  return user?.proxyToken?.trim() || null;
}

/** 构造带认证的请求头 */
function authHeaders(extra?: Record<string, string>): Record<string, string> {
  const token = getProxyToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...extra,
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

// ===== API 方法 =====

/**
 * 获取当前账号绑定的所有设备列表。
 * 后端根据当前 token 解析 user_id 返回该用户的所有设备（含离线）。
 */
export async function listDevices(): Promise<DeviceInfo[]> {
  const deviceId = await getDeviceId();
  const resp = await fetch(backendUrl("/api/devices"), {
    method: "GET",
    headers: authHeaders({ "X-Device-Id": deviceId }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`获取设备列表失败 (${resp.status}): ${text}`);
  }

  const data = await resp.json();
  return (data.devices ?? []) as DeviceInfo[];
}

/** 重命名设备（只能改自己账号下的设备） */
export async function renameDevice(deviceId: string, deviceName: string): Promise<void> {
  const resp = await fetch(backendUrl(`/api/devices/${encodeURIComponent(deviceId)}`), {
    method: "PATCH",
    headers: authHeaders(),
    body: JSON.stringify({ deviceName }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`重命名设备失败 (${resp.status}): ${text}`);
  }
}

/**
 * 解绑设备（断开当前用户与设备的关联）。
 * 设备上的数据保留，仅当用户主动调用 delete_my_data 才删除。
 */
export async function unbindDevice(deviceId: string): Promise<void> {
  const resp = await fetch(backendUrl(`/api/devices/${encodeURIComponent(deviceId)}`), {
    method: "DELETE",
    headers: authHeaders(),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`解绑设备失败 (${resp.status}): ${text}`);
  }
}
