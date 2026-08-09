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

// ===== TCP 测速（端对端测试用，匹配桌面客户端 TCP 协议）=====

export interface TcpSpeedTestParams {
  host: string;
  port: number;
  sizeMb?: number;
  connectTimeoutSecs?: number;
  readTimeoutSecs?: number;
}

export interface TcpSpeedTestResult {
  success: boolean;
  speedMbps: number;
  totalBytes: number;
  durationMs: number;
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
  // 所有 RPC 命令统一通过 relay_dispatch_rpc 入口分发，
  // 避免单独暴露 relay_ping/relay_tcping 等命令被 XSS 直接调用

  // ===== ping =====
  relay.registerCommand("ping", async (params: unknown) => {
    return await invoke<PingResult>("relay_dispatch_rpc", {
      command: "ping",
      params: params as PingParams,
    });
  });

  // ===== tcping =====
  relay.registerCommand("tcping", async (params: unknown) => {
    return await invoke<TcpingResult>("relay_dispatch_rpc", {
      command: "tcping",
      params: params as TcpingParams,
    });
  });

  // ===== node_latency =====
  relay.registerCommand("node_latency", async (params: unknown) => {
    return await invoke<NodeLatencyResult>("relay_dispatch_rpc", {
      command: "node_latency",
      params: params as NodeLatencyParams,
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
    // 将 requestId 注入 params 传给 Rust 端
    const paramsWithRequestId = {
      requestId: context.requestId,
      url: p.url,
      direction: p.direction,
      durationSecs: p.durationSecs,
      threads: p.threads,
    };
    return await invoke<SpeedtestResult>("relay_dispatch_rpc", {
      command: "speedtest",
      params: paramsWithRequestId,
    });
  });

  // ===== tcp_speed_test（端对端 TCP 测速，桌面端作为被测端时执行）=====
  relay.registerCommand("tcp_speed_test", async (params: unknown) => {
    const p = params as TcpSpeedTestParams;
    return await invoke<TcpSpeedTestResult>("tcp_speed_test", {
      host: p.host,
      port: p.port,
      sizeMb: p.sizeMb,
    });
  });

  // ===== e2e_setup / e2e_cleanup（端对端测试：本机作为服务端时创建/清理隧道）=====
  // 当其他桌面端发起「本机 → 对端」方向测试时，通过 relay 调用本机的 e2e_setup
  // 让本机创建临时隧道+测速服务端，返回隧道地址供对端测速
  relay.registerCommand("e2e_setup", async (params: unknown) => {
    const { tunnelService } = await import("./tunnelService");
    const { getStoredUser } = await import("./api");
    const p = params as { nodeName: string };

    // 启动 TCP 测速服务端
    await invoke("stop_tcp_speed_server");
    const tcpServerPort = await invoke<number>("start_tcp_speed_server");
    const serverOk = await invoke<boolean>("check_tcp_speed_server", { port: tcpServerPort });
    if (!serverOk) {
      throw new Error("TCP 测速服务端自检失败");
    }

    // 创建临时隧道
    const tunnelInfo = await tunnelService.createTempTunnel(tcpServerPort, p.nodeName);

    // 启动 frpc
    const user = getStoredUser();
    if (!user) throw new Error("请先登录");

    await invoke("start_frpc", {
      config: {
        server_addr: tunnelInfo.nodeIp,
        server_port: tunnelInfo.serverPort,
        user: user.usertoken,
        token: tunnelInfo.nodeToken,
        local_ip: "127.0.0.1",
        local_port: tunnelInfo.localPort,
        remote_port: tunnelInfo.remotePort,
        tunnel_name: tunnelInfo.tunnelName,
      },
    });

    // 等待 frpc 连接建立
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // 将隧道信息存到全局，供 e2e_cleanup 使用
    (globalThis as Record<string, unknown>).__e2eTunnelInfo = tunnelInfo;
    (globalThis as Record<string, unknown>).__e2eFrpcStarted = true;

    return {
      nodeIp: tunnelInfo.nodeIp,
      remotePort: tunnelInfo.remotePort,
    };
  });

  relay.registerCommand("e2e_cleanup", async () => {
    const { tunnelService } = await import("./tunnelService");
    const tunnelInfo = (globalThis as Record<string, unknown>).__e2eTunnelInfo;
    const frpcStarted = (globalThis as Record<string, unknown>).__e2eFrpcStarted;

    if (frpcStarted) {
      try { await invoke("stop_frpc"); } catch { /* ignore */ }
    }
    if (tunnelInfo) {
      try { await tunnelService.deleteTempTunnel(); } catch { /* ignore */ }
    }
    try { await tunnelService.cleanupAllTempTunnels(); } catch { /* ignore */ }
    try { await invoke("stop_tcp_speed_server"); } catch { /* ignore */ }

    (globalThis as Record<string, unknown>).__e2eTunnelInfo = null;
    (globalThis as Record<string, unknown>).__e2eFrpcStarted = false;

    return { cleaned: true };
  });

  // ===== delete_my_data（桌面端不支持）=====
  relay.registerCommand("delete_my_data", async () => {
    try {
      await invoke("relay_dispatch_rpc", {
        command: "delete_my_data",
        params: {},
      });
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
