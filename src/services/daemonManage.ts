/**
 * Daemon 远程管理服务层
 *
 * 通过 WebSocket 中继（relay）向目标 daemon 设备发送 RPC 命令，
 * 实现服务控制、更新管理、日志查看等远程运维能力。
 *
 * 账号与后端地址配置由服务端安装/登录流程管理，不通过此层控制。
 *
 * 调用方式参考 deviceApi.ts / relayHandlers.ts，
 * 统一使用 getRelayClient().sendRpc() 发送请求。
 */
import { getRelayClient, type RpcProgress } from "@/services/deviceRelay";

// ===== 类型定义 =====

/** daemon_service_control 的 action 枚举 */
export type ServiceAction = "start" | "stop" | "restart" | "status";

/** 服务状态信息（status 返回） */
export interface ServiceStatus {
  active: boolean;
  enabled: boolean;
  /** 原始状态文本，例如 "active (running)" */
  statusText?: string;
  pid?: number;
}

/** daemon_check_update 返回结构 */
export interface UpdateCheckResult {
  currentVersion: string;
  latestVersion: string;
  hasUpdate: boolean;
  releaseNotes?: string;
  publishedAt?: string;
  releaseName?: string;
}

/** daemon_get_update_settings 返回结构 */
export interface UpdateSettings {
  autoUpdate: boolean;
  currentVersion: string;
}

/** daemon_get_logs 返回结构 */
export interface DaemonLogs {
  /** 日志文本（按行分割后的数组） */
  lines: string[];
  /** 原始文本 */
  raw?: string;
}

// ===== 内部工具 =====

/**
 * 统一的 RPC 调用封装：发送请求并处理响应。
 * 失败时抛出 Error，成功时返回 data。
 */
async function callRpc<T>(
  deviceId: string,
  command: string,
  params: unknown,
  timeoutMs?: number,
): Promise<T> {
  const relay = getRelayClient();
  const resp = await relay.sendRpc<T>(deviceId, command, params, {
    ...(timeoutMs ? { timeoutMs } : {}),
  });
  if (!resp.success) {
    throw new Error(resp.error?.message || "RPC 调用失败");
  }
  // 部分命令可能返回 null data，统一转为空对象/空数组由调用方处理
  return resp.data as T;
}

/** 规范化日志返回为字符串数组 */
function normalizeLogs(data: unknown): DaemonLogs {
  if (data == null) return { lines: [] };
  if (typeof data === "string") {
    return {
      lines: data.split(/\r?\n/).filter((l) => l.length > 0),
      raw: data,
    };
  }
  if (Array.isArray(data)) {
    return { lines: data.map(String) };
  }
  // 对象形式：{ success, logs: "...", lines: N } 或 { lines: [...] } 或 { raw: "..." }
  const obj = data as Record<string, unknown>;
  // daemon 后端返回 { success, logs: "文本", lines: N }
  if (typeof obj.logs === "string") {
    return {
      lines: obj.logs.split(/\r?\n/).filter((l) => l.length > 0),
      raw: obj.logs,
    };
  }
  if (Array.isArray(obj.lines)) {
    return { lines: (obj.lines as unknown[]).map(String), raw: obj.raw as string | undefined };
  }
  if (typeof obj.raw === "string") {
    return normalizeLogs(obj.raw);
  }
  return { lines: [] };
}

/** 规范化服务状态返回 */
function normalizeStatus(data: unknown): ServiceStatus {
  if (data == null) return { active: false, enabled: false };
  if (typeof data === "string") {
    const text = data.toLowerCase();
    return {
      active: text.includes("active") && !text.includes("inactive") && !text.includes("failed"),
      enabled: !text.includes("disabled"),
      statusText: data,
    };
  }
  const obj = data as Record<string, unknown>;
  // daemon 后端 status 命令返回 { success, status: { activeState, enabledState } }
  // 取出嵌套的 status 对象
  const statusObj = (typeof obj.status === "object" && obj.status !== null)
    ? obj.status as Record<string, unknown>
    : obj;
  const activeState = typeof statusObj.activeState === "string" ? statusObj.activeState.toLowerCase() : "";
  const enabledState = typeof statusObj.enabledState === "string" ? statusObj.enabledState.toLowerCase() : "";
  const activeByText = activeState === "active";
  const enabledByText = enabledState === "enabled" || enabledState === "static" || enabledState === "enabled-runtime";
  return {
    active: Boolean(statusObj.active) || activeByText,
    enabled: Boolean(statusObj.enabled ?? statusObj.isEnabled) || enabledByText,
    statusText: typeof statusObj.statusText === "string"
      ? statusObj.statusText
      : activeState || enabledState
        ? `${activeState || "unknown"} / ${enabledState || "unknown"}`
        : undefined,
    pid: typeof statusObj.pid === "number" ? statusObj.pid : undefined,
  };
}

// ===== RPC 方法 =====

/**
 * 服务控制
 * @param action start/stop/restart/status
 */
export async function daemonServiceControl(
  deviceId: string,
  action: ServiceAction,
): Promise<ServiceStatus> {
  const data = await callRpc<unknown>(deviceId, "daemon_service_control", { action });
  return normalizeStatus(data);
}

/**
 * 获取日志
 * @param lines 期望获取的行数，默认 200
 */
export async function daemonGetLogs(deviceId: string, lines = 200): Promise<DaemonLogs> {
  const data = await callRpc<unknown>(deviceId, "daemon_get_logs", { lines });
  return normalizeLogs(data);
}

/**
 * 检查更新
 */
export async function daemonCheckUpdate(deviceId: string): Promise<UpdateCheckResult> {
  const data = await callRpc<UpdateCheckResult>(deviceId, "daemon_check_update", {});
  return {
    currentVersion: data?.currentVersion ?? "未知",
    latestVersion: data?.latestVersion ?? "未知",
    hasUpdate: Boolean(data?.hasUpdate),
    releaseNotes: data?.releaseNotes,
    publishedAt: data?.publishedAt,
    releaseName: data?.releaseName,
  };
}

/**
 * 执行更新（支持实时进度回调）
 * @param onProgress 进度回调，stage 字段携带详细日志文本，progress 为 0-100 的百分比
 */
export async function daemonPerformUpdate(
  deviceId: string,
  onProgress?: (p: RpcProgress) => void,
): Promise<void> {
  const relay = getRelayClient();
  // 更新可能耗时较长（下载+安装+重启），放宽超时到 5 分钟
  const resp = await relay.sendRpc(deviceId, "daemon_perform_update", {}, {
    timeoutMs: 300_000,
    onProgress,
  });
  if (!resp.success) {
    throw new Error(resp.error?.message || "RPC 调用失败");
  }
}

/**
 * 获取更新设置
 */
export async function daemonGetUpdateSettings(deviceId: string): Promise<UpdateSettings> {
  const data = await callRpc<UpdateSettings>(deviceId, "daemon_get_update_settings", {});
  return {
    autoUpdate: Boolean(data?.autoUpdate),
    currentVersion: data?.currentVersion ?? "未知",
  };
}

/**
 * 设置自动更新
 * @param enabled 是否启用自动更新
 */
export async function daemonSetAutoUpdate(deviceId: string, enabled: boolean): Promise<void> {
  await callRpc(deviceId, "daemon_set_auto_update", { enabled });
}
