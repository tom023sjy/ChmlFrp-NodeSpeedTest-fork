/**
 * 设备互联 RPC 命令处理器注册
 *
 * 将本机 Tauri 命令注册为 RPC 处理器，使本机作为「被管理端」时
 * 能响应管理端发来的远程命令。
 *
 * 命令清单（与 relay_commands.rs 对齐）：
 * - ping：ICMP 延迟
 * - tcping：TCP 连接延迟
 * - node_latency：组合命令（ping + tcping）
 * - speedtest：带宽测试（含进度推送）
 * - delete_my_data：删除设备数据（桌面端返回 NOT_SUPPORTED）
 *
 * speedtest 命令特殊处理：
 * Rust 端通过 `relay-speedtest-progress` 事件推送进度，
 * 本模块监听该事件，通过 relay.reportProgress 转发给管理端。
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { DeviceRelayClient, RpcContext } from "./deviceRelay";

// ===== 命令参数/返回类型（与 API 需求文档 6.1-6.5 对齐）=====

export interface PingParams {
  host: string;
  count?: number;
}

export interface PingResult {
  rtts: number[];
  min: number | null;
  avg: number | null;
  max: number | null;
  loss: number;
}

export interface TcpingParams {
  host: string;
  port: number;
  count?: number;
  timeoutSecs?: number;
}

export interface TcpingResult {
  rtts: number[];
  avg: number | null;
  loss: number;
}

export interface NodeLatencyParams {
  node: string;
  port: number;
  count?: number;
}

export interface NodeLatencyResult {
  ping: PingResult;
  tcping: TcpingResult;
}

export interface SpeedtestParams {
  url: string;
  direction: "download" | "upload" | "both";
  durationSecs?: number;
  threads?: number;
}

export interface SpeedtestResult {
  success: boolean;
  downloadSpeedMbps: number;
  uploadSpeedMbps: number;
  latencyMs: number | null;
  jitterMs: number | null;
  error: string | null;
}

// ===== speedtest 进度事件（Rust → 前端）=====

interface SpeedtestProgressEvent {
  requestId: string;
  progress: number;
  stage: string;
  speedMbps: number;
}

/**
 * 注册所有 RPC 命令处理器到 relay 客户端
 *
 * @returns 取消注册函数（移除所有命令处理器和事件监听）
 */
export function registerRelayHandlers(relay: DeviceRelayClient): () => void {
  // ===== ping =====
  relay.registerCommand("ping", async (params: unknown) => {
    const p = params as PingParams;
    return await invoke<PingResult>("relay_ping", {
      host: p.host,
      count: p.count,
    });
  });

  // ===== tcping =====
  relay.registerCommand("tcping", async (params: unknown) => {
    const p = params as TcpingParams;
    return await invoke<TcpingResult>("relay_tcping", {
      host: p.host,
      port: p.port,
      count: p.count,
      timeoutSecs: p.timeoutSecs,
    });
  });

  // ===== node_latency =====
  relay.registerCommand("node_latency", async (params: unknown) => {
    const p = params as NodeLatencyParams;
    return await invoke<NodeLatencyResult>("relay_node_latency", {
      node: p.node,
      port: p.port,
      count: p.count,
    });
  });

  // ===== speedtest（含进度推送）=====
  // Rust 端通过 `relay-speedtest-progress` 事件推送进度，
  // 此处监听事件并通过 relay.reportProgress 转发给管理端。
  // 使用 RPC 的 requestId 作为 Rust 端的 requestId，确保进度事件正确关联。
  let progressUnlisten: UnlistenFn | null = null;
  listen<SpeedtestProgressEvent>("relay-speedtest-progress", (event) => {
    const { requestId, progress, stage, speedMbps } = event.payload;
    relay.reportProgress(requestId, { progress, stage, speedMbps });
  })
    .then((unlisten) => {
      progressUnlisten = unlisten;
    })
    .catch((err) => {
      console.warn("[relayHandlers] 监听 speedtest 进度事件失败:", err);
    });

  relay.registerCommand("speedtest", async (params: unknown, context: RpcContext) => {
    const p = params as SpeedtestParams;
    // 使用管理端的 requestId 传给 Rust 端，进度事件通过该 requestId 关联
    return await invoke<SpeedtestResult>("relay_speedtest", {
      requestId: context.requestId,
      url: p.url,
      direction: p.direction,
      durationSecs: p.durationSecs,
      threads: p.threads,
    });
  });

  // ===== delete_my_data（桌面端不支持）=====
  relay.registerCommand("delete_my_data", async () => {
    try {
      await invoke("relay_delete_my_data");
      return { deleted: true };
    } catch (err) {
      // 桌面端返回 NOT_SUPPORTED，转换为 RPC 错误
      throw new Error(err instanceof Error ? err.message : String(err));
    }
  });

  // 返回取消注册函数
  return () => {
    if (progressUnlisten) {
      progressUnlisten();
      progressUnlisten = null;
    }
    // relay.registerCommand 没有提供 unregister 方法，
    // 但在 disconnect 时 commandHandlers 会被保留。
    // 实际场景中 relay 实例是全局单例，注册一次即可。
  };
}
