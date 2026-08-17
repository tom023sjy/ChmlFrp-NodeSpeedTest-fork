import { BACKEND_API_BASE_URL } from "@/lib/api-endpoints";
import {
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  isCurrentSocket,
} from "./relayHeartbeat";

/** 已登录时上报 RPC 事件，失败静默处理（动态导入避免循环依赖） */
function reportRpcEvent(eventType: string, eventData: Record<string, unknown>): void {
  try {
    // 动态导入避免循环依赖
    void Promise.all([
      import("./backendApi"),
      import("./api"),
    ]).then(([{ reportUsage }, { getStoredUser }]) => {
      if (!getStoredUser()?.accessToken) return;
      reportUsage({ eventType, eventData }).catch(() => {});
    });
  } catch {
    // 忽略上报失败
  }
}

/**
 * 设备互联 WebSocket 中继客户端
 *
 * 职责：
 * - 连接后端中继服务，注册本机设备
 * - 连接后立即心跳，之后每 10 秒保活
 * - 接收设备上下线事件
 * - 发送 RPC 请求到目标设备，管理请求-响应映射与超时
 * - 接收 RPC 请求（作为被管理端），调用注册的命令处理器执行
 * - 转发 RPC 进度推送
 * - 断线自动重连
 */

// ===== 类型定义 =====

export interface ConnectOpts {
  deviceType: "desktop" | "daemon";
  deviceName?: string;
  osInfo: string;
  hostname: string;
  interconnect: boolean;
  capabilities?: string[];
}

export interface RpcResponse<T = unknown> {
  success: boolean;
  data: T | null;
  error: { code: string; message: string } | null;
}

export interface RpcProgress {
  requestId: string;
  progress: number;
  stage: string;
  speedMbps?: number;
}

export interface DeviceEvent {
  deviceId: string;
  deviceName: string;
  deviceType?: string;
}

export interface DnsMonitorRelayEvent {
  taskId: string;
  revision?: number;
  eventType?: string;
  runtimeStatus?: string;
  executionTarget?: { type: "cloud" | "device"; id: string };
  lastCheckAt?: string;
}

export type RelayConnectionPhase = "idle" | "connecting" | "connected" | "reconnecting" | "auth_failed";

export interface RelayConnectionState {
  phase: RelayConnectionPhase;
  message: string;
  lastConnectedAt: number | null;
}

type CommandHandler = (params: unknown, context: RpcContext) => Promise<unknown>;

/** RPC 调用上下文，传递 requestId 等信息给命令处理器 */
export interface RpcContext {
  /** 管理端生成的 requestId，用于进度上报等场景 */
  requestId: string;
  /** 发起方设备 ID */
  fromDeviceId: string;
  signal: AbortSignal;
}

type EventCallback = (e: DeviceEvent) => void;

// ===== 内部消息类型 =====

type IncomingMessage =
  | { type: "pong" }
  | { type: "device_online"; deviceId: string; deviceName: string; deviceType: string }
  | { type: "device_offline"; deviceId: string; deviceName: string }
  | { type: "rpc_request"; requestId: string; command: string; params: unknown; fromDeviceId: string }
  | { type: "rpc_cancel"; requestId: string; runId?: string; command?: string; fromDeviceId: string }
  | { type: "rpc_response"; requestId: string; success: boolean; data: unknown; error: { code: string; message: string } | null }
  | { type: "rpc_progress"; requestId: string; progress: number; stage: string; speedMbps?: number }
  | ({ type: "dns-monitor-event" } & DnsMonitorRelayEvent);

// ===== 客户端实现 =====

const RECONNECT_DELAY_MS = 3_000;
const DEFAULT_RPC_TIMEOUT_MS = 30_000;
const SPEEDTEST_RPC_TIMEOUT_MS = 120_000;

export class DeviceRelayClient {
  private ws: WebSocket | null = null;
  private url: string | null = null;

  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastPongAt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private isManualDisconnect = false;

  /** RPC 请求待响应映射 */
  private pendingRpc = new Map<
    string,
    {
      resolve: (v: RpcResponse) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  /** 进度订阅映射 */
  private progressCallbacks = new Map<string, ((p: RpcProgress) => void)[]>();

  /** 本机命令处理器 */
  private commandHandlers = new Map<string, CommandHandler>();
  private activeIncomingRpc = new Map<string, {
    command: string;
    params: unknown;
    context: RpcContext;
    abortController: AbortController;
  }>();

  /** 设备上下线事件回调 */
  private eventCallbacks = {
    device_online: new Set<EventCallback>(),
    device_offline: new Set<EventCallback>(),
    dns_monitor_event: new Set<(event: DnsMonitorRelayEvent) => void>(),
  };

  /** 连接状态变更回调 */
  private connectionCallbacks = new Set<(connected: boolean) => void>();
  private connectionStateCallbacks = new Set<(state: RelayConnectionState) => void>();
  private connectionState: RelayConnectionState = {
    phase: "idle",
    message: "中继未连接",
    lastConnectedAt: null,
  };

  /** 当前是否已连接 */
  private connected = false;

  /** 建立连接 */
  async connect(token: string, deviceId: string, opts: ConnectOpts): Promise<void> {
    this.isManualDisconnect = false;

    // 构建 WebSocket URL
    const wsBase = BACKEND_API_BASE_URL.replace(/^http/, "ws");
    const params = new URLSearchParams({
      token,
      deviceId,
      deviceType: opts.deviceType,
      ...(opts.deviceName ? { deviceName: opts.deviceName } : {}),
      osInfo: opts.osInfo,
      hostname: opts.hostname,
      interconnect: opts.interconnect ? "1" : "0",
      capabilities: JSON.stringify(Object.fromEntries((opts.capabilities ?? []).map((capability) => {
        const match = /^([a-z0-9_]+)\.v(\d+)$/.exec(capability);
        return match ? [match[1], Number(match[2])] : [capability, 1];
      }))),
    });
    this.url = `${wsBase}/api/devices/ws?${params.toString()}`;
    return this.doConnect();
  }

  /** 主动断开 */
  disconnect(): void {
    this.isManualDisconnect = true;
    this.cleanupTimers();
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
    this.setConnected(false);
    this.setConnectionState({ phase: "idle", message: "中继未连接" });
  }

  /** 是否已连接 */
  isConnected(): boolean {
    return this.connected;
  }

  /** 监听连接状态 */
  onConnectionChange(cb: (connected: boolean) => void): () => void {
    this.connectionCallbacks.add(cb);
    return () => this.connectionCallbacks.delete(cb);
  }

  /** 发送 RPC 请求到目标设备
   *
   * @param onProgress 可选进度回调，在 requestId 生成后立即注册，
   *                   确保 RPC 执行过程中的进度推送不会丢失。
   *                   回调会在 RPC 完成/超时/失败后自动注销。
   */
  sendRpc<T = unknown>(
    targetDeviceId: string,
    command: string,
    params: unknown,
    options?: {
      timeoutMs?: number;
      onProgress?: (p: RpcProgress) => void;
      signal?: AbortSignal;
      runId?: string;
    },
  ): Promise<RpcResponse<T>> {
    const timeoutMs = options?.timeoutMs ?? (command === "speedtest" ? SPEEDTEST_RPC_TIMEOUT_MS : DEFAULT_RPC_TIMEOUT_MS);

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.resolve({
        success: false,
        data: null,
        error: { code: "NOT_CONNECTED", message: "中继连接未就绪" },
      });
    }

    const requestId = crypto.randomUUID();

    // 在发送 RPC 之前注册进度回调，避免进度推送早于注册到达
    let unlistenProgress: (() => void) | null = null;
    if (options?.onProgress) {
      unlistenProgress = this.onProgress(requestId, options.onProgress);
    }

    const message = {
      type: "rpc_request",
      requestId,
      targetDeviceId,
      command,
      // 顶层 runId 供后端关联活动任务（断线清理、e2e_cleanup 等）；
      // 与 params.runId 保持一致
      ...(options?.runId ? { runId: options.runId } : {}),
      params,
    };

    return new Promise<RpcResponse<T>>((resolve, reject) => {
      const handleAbort = () => {
        clearTimeout(timer);
        this.pendingRpc.delete(requestId);
        this.progressCallbacks.delete(requestId);
        unlistenProgress?.();
        options?.signal?.removeEventListener("abort", handleAbort);
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({
            type: "rpc_cancel",
            requestId,
            targetDeviceId,
            runId: options?.runId,
            command,
          }));
        }
        reject(options?.signal?.reason instanceof Error
          ? options.signal.reason
          : new DOMException("RPC 已中止", "AbortError"));
      };
      const timer = setTimeout(() => {
        this.pendingRpc.delete(requestId);
        this.progressCallbacks.delete(requestId);
        unlistenProgress?.();
        options?.signal?.removeEventListener("abort", handleAbort);
        // RPC 超时（确认为真实失败）
        reportRpcEvent("rpc_timeout", { command, timeout_ms: timeoutMs });
        reportRpcEvent("rpc_failure", { command, error_code: "TIMEOUT" });
        resolve({
          success: false,
          data: null,
          error: { code: "TIMEOUT", message: `目标设备 ${timeoutMs / 1000} 秒内未响应` },
        });
      }, timeoutMs);

      this.pendingRpc.set(requestId, {
        resolve: (v: RpcResponse) => {
          clearTimeout(timer);
          unlistenProgress?.();
          options?.signal?.removeEventListener("abort", handleAbort);
          // 基于 RPC 响应可靠上报成功/失败
          if (v.success) {
            reportRpcEvent("rpc_success", { command });
          } else {
            reportRpcEvent("rpc_failure", { command, error_code: v.error?.code || "UNKNOWN" });
          }
          resolve(v as RpcResponse<T>);
        },
        reject: (e: Error) => {
          clearTimeout(timer);
          unlistenProgress?.();
          options?.signal?.removeEventListener("abort", handleAbort);
          // RPC 发送或处理异常（确认为真实失败）
          reportRpcEvent("rpc_failure", { command, error_code: "EXCEPTION", reason: e.message });
          reject(e);
        },
        timer,
      });

      if (options?.signal?.aborted) {
        handleAbort();
        return;
      }
      options?.signal?.addEventListener("abort", handleAbort, { once: true });

      try {
        this.ws!.send(JSON.stringify(message));
      } catch (err) {
        clearTimeout(timer);
        this.pendingRpc.delete(requestId);
        unlistenProgress?.();
        options?.signal?.removeEventListener("abort", handleAbort);
        const reason = err instanceof Error ? err.message : String(err);
        // WebSocket 发送失败（确认为真实失败）
        reportRpcEvent("rpc_failure", { command, error_code: "SEND_FAILED", reason });
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** 订阅某个 RPC 请求的进度推送 */
  onProgress(requestId: string, cb: (p: RpcProgress) => void): () => void {
    const list = this.progressCallbacks.get(requestId) || [];
    list.push(cb);
    this.progressCallbacks.set(requestId, list);
    return () => {
      const arr = this.progressCallbacks.get(requestId);
      if (!arr) return;
      const idx = arr.indexOf(cb);
      if (idx >= 0) arr.splice(idx, 1);
      if (arr.length === 0) this.progressCallbacks.delete(requestId);
    };
  }

  /** 作为被管理端：上报进度到管理端 */
  reportProgress(requestId: string, payload: { progress: number; stage: string; speedMbps?: number }): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(
        JSON.stringify({
          type: "rpc_progress",
          requestId,
          ...payload,
        }),
      );
    } catch (err) {
      console.warn("[relay] 上报进度失败:", err);
    }
  }

  /** 注册本机命令处理器（作为被管理端） */
  registerCommand(command: string, handler: CommandHandler): void {
    this.commandHandlers.set(command, handler);
  }

  /** 监听设备上下线事件 */
  on(event: "device_online" | "device_offline", cb: EventCallback): () => void {
    this.eventCallbacks[event].add(cb);
    return () => this.eventCallbacks[event].delete(cb);
  }

  onDnsMonitorEvent(cb: (event: DnsMonitorRelayEvent) => void): () => void {
    this.eventCallbacks.dns_monitor_event.add(cb);
    return () => this.eventCallbacks.dns_monitor_event.delete(cb);
  }

  getConnectionState(): RelayConnectionState {
    return { ...this.connectionState };
  }

  onConnectionStateChange(cb: (state: RelayConnectionState) => void): () => void {
    this.connectionStateCallbacks.add(cb);
    return () => this.connectionStateCallbacks.delete(cb);
  }

  // ===== 内部实现 =====

  private async doConnect(): Promise<void> {
    if (!this.url) return;
    this.setConnectionState({ phase: "connecting", message: "正在连接中继" });

    try {
      const ws = new WebSocket(this.url);
      this.ws = ws;

      ws.onopen = () => {
        if (!isCurrentSocket(this.ws, ws)) return;
        console.log("[relay] WebSocket 已连接");
        this.lastPongAt = Date.now();
        this.startHeartbeat(ws);
        this.setConnected(true);
        this.setConnectionState({
          phase: "connected",
          message: "中继已连接",
          lastConnectedAt: Date.now(),
        });
      };

      ws.onmessage = (ev) => {
        if (!isCurrentSocket(this.ws, ws)) return;
        this.handleMessage(ev.data);
      };

      ws.onerror = (ev) => {
        if (!isCurrentSocket(this.ws, ws)) return;
        console.warn("[relay] WebSocket 错误:", ev);
        this.setConnectionState({ phase: "reconnecting", message: "中继连接异常，等待重连" });
      };

      ws.onclose = (event) => {
        if (!isCurrentSocket(this.ws, ws)) return;
        this.ws = null;
        console.log("[relay] WebSocket 已关闭");
        this.stopHeartbeat();
        this.setConnected(false);
        const authFailed = event.code === 4001 || event.code === 4003;
        this.setConnectionState({
          phase: authFailed ? "auth_failed" : "reconnecting",
          message: authFailed ? "中继鉴权失败，请重新登录" : "中继已断开，等待重连",
        });
        // 失败所有待响应请求
        this.failAllPending("连接已断开");
        if (!this.isManualDisconnect) {
          this.scheduleReconnect();
        }
      };
    } catch (err) {
      console.error("[relay] 连接失败:", err);
      this.setConnectionState({ phase: "reconnecting", message: "中继连接失败，等待重连" });
      this.scheduleReconnect();
    }
  }

  private handleMessage(raw: unknown): void {
    let msg: IncomingMessage;
    try {
      const text = typeof raw === "string" ? raw : "";
      msg = JSON.parse(text) as IncomingMessage;
    } catch {
      console.warn("[relay] 无法解析消息:", raw);
      return;
    }

    switch (msg.type) {
      case "pong":
        this.lastPongAt = Date.now();
        break;

      case "device_online":
        this.eventCallbacks.device_online.forEach((cb) =>
          cb({ deviceId: msg.deviceId, deviceName: msg.deviceName, deviceType: msg.deviceType }),
        );
        break;

      case "device_offline":
        this.eventCallbacks.device_offline.forEach((cb) =>
          cb({ deviceId: msg.deviceId, deviceName: msg.deviceName }),
        );
        break;

      case "rpc_request":
        void this.handleRpcRequest(msg);
        break;

      case "rpc_cancel":
        void this.handleRpcCancel(msg);
        break;

      case "rpc_response": {
        const pending = this.pendingRpc.get(msg.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingRpc.delete(msg.requestId);
          pending.resolve({
            success: msg.success,
            data: msg.data,
            error: msg.error,
          });
          // 响应到达后清理进度订阅
          this.progressCallbacks.delete(msg.requestId);
        }
        break;
      }

      case "rpc_progress": {
        const cbs = this.progressCallbacks.get(msg.requestId);
        if (cbs) {
          cbs.forEach((cb) =>
            cb({
              requestId: msg.requestId,
              progress: msg.progress,
              stage: msg.stage,
              speedMbps: msg.speedMbps,
            }),
          );
        }
        break;
      }

      case "dns-monitor-event":
        this.eventCallbacks.dns_monitor_event.forEach((cb) => cb(msg));
        break;
    }
  }

  /** 作为被管理端：接收并执行 RPC 请求 */
  private async handleRpcRequest(msg: IncomingMessage & { type: "rpc_request" }): Promise<void> {
    const { requestId, command, params, fromDeviceId } = msg;
    const handler = this.commandHandlers.get(command);

    if (!handler) {
      this.sendRpcResponse(requestId, false, null, {
        code: "UNKNOWN_COMMAND",
        message: `不支持的命令: ${command}`,
      });
      return;
    }

    const abortController = new AbortController();
    const context = { requestId, fromDeviceId, signal: abortController.signal };
    this.activeIncomingRpc.set(requestId, { command, params, context, abortController });
    try {
      const data = await handler(params, context);
      this.sendRpcResponse(requestId, true, data, null);
    } catch (err) {
      this.sendRpcResponse(requestId, false, null, {
        code: "EXEC_FAILED",
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.activeIncomingRpc.delete(requestId);
    }
  }

  private async handleRpcCancel(msg: IncomingMessage & { type: "rpc_cancel" }): Promise<void> {
    const active = this.activeIncomingRpc.get(msg.requestId);
    active?.abortController.abort(new DOMException("测速已强制停止", "AbortError"));
    const runId = msg.runId
      ?? (active?.params as { runId?: string } | null)?.runId;
    if (runId && active?.command !== "e2e_setup" && msg.command !== "e2e_setup") {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("cancel_full_chain_test", { runId }).catch(() => undefined);
    }
    if (active && (active.command === "e2e_setup" || msg.command === "e2e_setup")) {
      const cleanup = this.commandHandlers.get("e2e_cleanup");
      if (cleanup) await cleanup({ runId }, active.context).catch(() => undefined);
    }
  }

  private sendRpcResponse(
    requestId: string,
    success: boolean,
    data: unknown,
    error: { code: string; message: string } | null,
  ): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(
        JSON.stringify({ type: "rpc_response", requestId, success, data, error }),
      );
    } catch (err) {
      console.warn("[relay] 发送响应失败:", err);
    }
  }

  private startHeartbeat(ws: WebSocket): void {
    this.stopHeartbeat();
    this.sendHeartbeat(ws);
    this.heartbeatTimer = setInterval(() => {
      if (!isCurrentSocket(this.ws, ws) || ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() - this.lastPongAt > HEARTBEAT_TIMEOUT_MS) {
        console.warn("[relay] 心跳超时，主动断开重连");
        ws.close();
        return;
      }
      this.sendHeartbeat(ws);
    }, HEARTBEAT_INTERVAL_MS);
  }

  private sendHeartbeat(ws: WebSocket): void {
    if (!isCurrentSocket(this.ws, ws) || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify({ type: "ping" }));
    } catch {
      ws.close();
    }
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.setConnectionState({ phase: "reconnecting", message: "等待重新连接中继" });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.isManualDisconnect) {
        console.log("[relay] 尝试重连...");
        void this.doConnect();
      }
    }, RECONNECT_DELAY_MS);
  }

  private cleanupTimers(): void {
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private failAllPending(reason: string): void {
    this.pendingRpc.forEach(({ resolve, timer }) => {
      clearTimeout(timer);
      resolve({
        success: false,
        data: null,
        error: { code: "CONNECTION_CLOSED", message: reason },
      });
    });
    this.pendingRpc.clear();
    this.progressCallbacks.clear();
  }

  private setConnected(connected: boolean): void {
    this.connected = connected;
    this.connectionCallbacks.forEach((cb) => cb(connected));
  }

  private setConnectionState(next: Partial<RelayConnectionState>): void {
    this.connectionState = { ...this.connectionState, ...next };
    this.connectionStateCallbacks.forEach((callback) => callback(this.getConnectionState()));
  }
}

/** 全局单例 */
let relayInstance: DeviceRelayClient | null = null;

export function getRelayClient(): DeviceRelayClient {
  if (!relayInstance) {
    relayInstance = new DeviceRelayClient();
  }
  return relayInstance;
}
