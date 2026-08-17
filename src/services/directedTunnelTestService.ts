import { invoke } from "@tauri-apps/api/core";
import { awaitWithAbort } from "./abortable";
import { getStoredUser } from "./api";
import { getRelayClient, type RpcProgress } from "./deviceRelay";
import { frpcService } from "./frpcService";
import { cleanupRemoteResources } from "./remoteCleanup";
import { isDefenderBlockedError } from "./speedTestService";
import { tunnelService, type TempTunnelInfo } from "./tunnelService";
import type {
  UnifiedTestParams,
  UnifiedTestResult,
} from "./unifiedTestService";
import type { TcpSpeedTestResult, TunnelLatencyResult } from "./relayHandlers";

interface TunnelAddress {
  host: string;
  port: number;
}

interface SenderExecutor {
  setup(): Promise<TunnelAddress>;
  cleanup(): Promise<void>;
}

interface ReceiverExecutor {
  latency(address: TunnelAddress): Promise<TunnelLatencyResult>;
  speed(
    address: TunnelAddress,
    durationSeconds: number,
    onProgress: (progress: RpcProgress) => void,
  ): Promise<TcpSpeedTestResult>;
}

function localSender(params: UnifiedTestParams): SenderExecutor {
  let tunnel: TempTunnelInfo | null = null;
  let serverStarted = false;
  let frpcStarted = false;
  return {
    async setup() {
      if (!(await frpcService.checkFrpcExists())) {
        await frpcService.downloadFrpc((progress) => {
          params.onProgress(
            "downloading_frpc",
            5 + progress.percentage * 0.15,
            "正在下载 frpc...",
          );
        });
      }
      await invoke("stop_tcp_speed_server");
      const localPort = await invoke<number>("start_tcp_speed_server");
      serverStarted = true;
      if (
        !(await invoke<boolean>("check_tcp_speed_server", { port: localPort }))
      ) {
        throw new Error("全链路测试服务自检失败");
      }
      const tunnelStartedAt = Date.now();
      try {
        tunnel = await tunnelService.createTempTunnel(
          localPort,
          params.nodeName,
        );
        params.events?.onTunnelCreateSuccess?.(Date.now() - tunnelStartedAt);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        params.events?.onTunnelCreateFailure?.(
          Date.now() - tunnelStartedAt,
          "TUNNEL_CREATE_FAILED",
          reason,
        );
        throw error;
      }
      const user = getStoredUser();
      if (!user) throw new Error("请先登录");
      const frpcStartedAt = Date.now();
      try {
        await invoke("start_frpc", {
          config: {
            server_addr: tunnel.nodeIp,
            server_port: tunnel.serverPort,
            user: user.usertoken,
            token: tunnel.nodeToken,
            local_ip: "127.0.0.1",
            local_port: tunnel.localPort,
            remote_port: tunnel.remotePort,
            tunnel_name: tunnel.tunnelName,
          },
        });
        frpcStarted = true;
        params.events?.onFrpcStartSuccess?.(Date.now() - frpcStartedAt);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        params.events?.onFrpcStartFailure?.(
          Date.now() - frpcStartedAt,
          isDefenderBlockedError(reason) ? "defender_blocked" : "generic",
          "FRPC_START_FAILED",
        );
        throw error;
      }
      await awaitWithAbort(
        new Promise((resolve) => setTimeout(resolve, 3000)),
        params.signal,
      );
      return { host: tunnel.nodeIp, port: tunnel.remotePort };
    },
    async cleanup() {
      const errors: string[] = [];
      if (frpcStarted && tunnel)
        await invoke("stop_frpc", { tunnelName: tunnel.tunnelName }).catch(
          (error) => errors.push(String(error)),
        );
      if (tunnel)
        await tunnelService
          .deleteTempTunnel()
          .catch((error) => errors.push(String(error)));
      await tunnelService
        .cleanupAllTempTunnels()
        .catch((error) => errors.push(String(error)));
      if (serverStarted)
        await invoke("stop_tcp_speed_server").catch((error) =>
          errors.push(String(error)),
        );
      if (errors.length > 0)
        throw new Error(`资源清理失败: ${errors.join("；")}`);
    },
  };
}

function remoteSender(params: UnifiedTestParams): SenderExecutor {
  let setupRequested = false;
  return {
    async setup() {
      const startedAt = Date.now();
      setupRequested = true;
      const response = await getRelayClient().sendRpc<{
        nodeIp: string;
        remotePort: number;
        protocolVersion?: number;
      }>(
        params.senderDeviceId,
        "e2e_setup",
        { nodeName: params.nodeName, protocolVersion: 2, runId: params.runId },
        { timeoutMs: 90000, signal: params.signal, runId: params.runId },
      );
      if (!response.success || !response.data) {
        const reason = response.error?.message ?? "远程发送端准备失败";
        params.events?.onTunnelCreateFailure?.(
          Date.now() - startedAt,
          "REMOTE_SETUP_FAILED",
          reason,
        );
        throw new Error(reason);
      }
      if (response.data.protocolVersion !== 2) {
        throw new Error("发送端不支持全链路测试协议 v2，请先更新该主机客户端");
      }
      params.events?.onTunnelCreateSuccess?.(Date.now() - startedAt);
      params.events?.onFrpcStartSuccess?.(Date.now() - startedAt);
      return { host: response.data.nodeIp, port: response.data.remotePort };
    },
    async cleanup() {
      if (!setupRequested) return;
      await cleanupRemoteResources(() =>
        getRelayClient().sendRpc<{
          cleaned: boolean;
          reason?: string;
        }>(
          params.senderDeviceId,
          "e2e_cleanup",
          { runId: params.runId },
          { timeoutMs: 30000 },
        ),
      );
    },
  };
}

function localReceiver(params: UnifiedTestParams): ReceiverExecutor {
  return {
    latency: (address) =>
      awaitWithAbort(
        invoke<TunnelLatencyResult>("tunnel_latency_test", {
          host: address.host,
          port: address.port,
          count: 4,
          timeoutMs: 3000,
          runId: params.runId,
        }),
        params.signal,
      ),
    async speed(address, durationSeconds) {
      const result = await awaitWithAbort(
        invoke<{
          success: boolean;
          speed_mbps: number;
          total_bytes: number;
          duration_ms: number;
          speed_samples: TcpSpeedTestResult["speedSamples"];
          error: string | null;
        }>("tcp_speed_test", {
          host: address.host,
          port: address.port,
          durationSeconds,
          runId: params.runId,
        }),
        params.signal,
      );
      return {
        success: result.success,
        speedMbps: result.speed_mbps,
        totalBytes: result.total_bytes,
        durationMs: result.duration_ms,
        speedSamples: result.speed_samples,
        error: result.error,
      };
    },
  };
}

function remoteReceiver(params: UnifiedTestParams): ReceiverExecutor {
  return {
    async latency(address) {
      const response = await getRelayClient().sendRpc<TunnelLatencyResult>(
        params.receiverDeviceId,
        "tunnel_latency_test",
        {
          host: address.host,
          port: address.port,
          count: 4,
          timeoutMs: 3000,
          runId: params.runId,
        },
        { timeoutMs: 30000, signal: params.signal, runId: params.runId },
      );
      if (!response.success || !response.data)
        throw new Error(response.error?.message ?? "全链路 RTT 测试失败");
      return response.data;
    },
    async speed(address, durationSeconds, onProgress) {
      const response = await getRelayClient().sendRpc<TcpSpeedTestResult>(
        params.receiverDeviceId,
        "tcp_speed_test",
        {
          host: address.host,
          port: address.port,
          durationSeconds,
          runId: params.runId,
        },
        {
          timeoutMs: (durationSeconds + 30) * 1_000,
          onProgress,
          signal: params.signal,
          runId: params.runId,
        },
      );
      if (!response.success || !response.data)
        throw new Error(response.error?.message ?? "全链路带宽测试失败");
      return response.data;
    },
  };
}

function ensureNotAborted(params: UnifiedTestParams): void {
  if (params.signal.aborted) {
    throw params.signal.reason instanceof Error
      ? params.signal.reason
      : new DOMException("测速已强制停止", "AbortError");
  }
}

export async function runDirectedTunnelTest(
  params: UnifiedTestParams,
): Promise<UnifiedTestResult> {
  const sender =
    params.senderDeviceId === "local"
      ? localSender(params)
      : remoteSender(params);
  const receiver =
    params.receiverDeviceId === "local"
      ? localReceiver(params)
      : remoteReceiver(params);
  let latency: number | null = null;
  let downloadSpeed: number | null = null;
  let latencySamples: Array<number | null> = [];
  let speedSamples: NonNullable<TcpSpeedTestResult["speedSamples"]> = [];
  let jitterMs: number | null = null;
  let packetLossPercent: number | null = null;
  let testDurationSeconds: number | null = null;
  let latencyStartedAt: number | null = null;
  let speedStartedAt: number | null = null;
  let result: UnifiedTestResult = {
    latency: null,
    downloadSpeed: null,
    latencySamples: [],
    speedSamples: [],
    jitterMs: null,
    packetLossPercent: null,
    testDurationSeconds: null,
    error: "测试未完成",
    errorType: "generic",
  };
  const cancelLocalReceiver = () => {
    if (params.receiverDeviceId === "local") {
      void invoke("cancel_full_chain_test", { runId: params.runId });
    }
  };
  params.signal.addEventListener("abort", cancelLocalReceiver, { once: true });
  try {
    params.onProgress(
      "preparing_sender",
      5,
      `正在准备发送端 ${params.senderDeviceName}...`,
    );
    params.onLog(
      `正在建立 ${params.senderDeviceName} → ${params.nodeName} → ${params.receiverDeviceName} 全链路`,
      "info",
    );
    const address = await sender.setup();
    params.onLog(
      `全链路隧道已就绪: ${address.host}:${address.port}`,
      "success",
    );
    ensureNotAborted(params);

    if (params.testLatency) {
      params.onProgress("testing_latency", 45, "正在通过隧道测试全链路 RTT...");
      latencyStartedAt = Date.now();
      const latencyResult = await receiver.latency(address);
      if (!latencyResult.success || latencyResult.received === 0)
        throw new Error(latencyResult.error ?? "全链路 RTT 测试失败");
      latency = Math.round(latencyResult.avgMs * 100) / 100;
      latencySamples = latencyResult.rtts;
      jitterMs = latencyResult.jitterMs;
      packetLossPercent = latencyResult.lossPercent;
      params.onLog(
        `全链路 RTT: ${latency}ms，抖动: ${latencyResult.jitterMs.toFixed(2)}ms，丢包: ${latencyResult.lossPercent.toFixed(1)}%`,
        "success",
      );
      params.events?.onLatencyTestSuccess?.(
        latency,
        Date.now() - latencyStartedAt,
      );
    }
    ensureNotAborted(params);

    if (params.testSpeed) {
      params.onProgress(
        "testing_speed",
        60,
        `正在测试 ${params.senderDeviceName} → ${params.receiverDeviceName} 全链路带宽...`,
      );
      speedStartedAt = Date.now();
      const speedResult = await receiver.speed(
        address,
        params.durationSeconds,
        (progress) => {
          params.onProgress(
            "testing_speed",
            60 + progress.progress * 0.35,
            `全链路带宽测试中... ${progress.speedMbps?.toFixed(1) ?? ""} Mbps`,
          );
        },
      );
      if (!speedResult.success || speedResult.totalBytes <= 0)
        throw new Error(speedResult.error ?? "全链路带宽测试失败");
      downloadSpeed = Math.round(speedResult.speedMbps * 100) / 100;
      speedSamples = speedResult.speedSamples;
      testDurationSeconds = speedResult.durationMs / 1_000;
      params.onLog(
        `定向带宽 ${params.senderDeviceName} → ${params.receiverDeviceName}: ${downloadSpeed} Mbps`,
        "success",
      );
      params.events?.onSpeedTestSuccess?.(
        downloadSpeed,
        params.durationSeconds,
        Date.now() - speedStartedAt,
      );
    }
    result = {
      latency,
      downloadSpeed,
      latencySamples,
      speedSamples,
      jitterMs,
      packetLossPercent,
      testDurationSeconds,
      error: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (latencyStartedAt != null && latency == null)
      params.events?.onLatencyTestFailure?.(
        Date.now() - latencyStartedAt,
        message,
      );
    if (speedStartedAt != null && downloadSpeed == null)
      params.events?.onSpeedTestFailure?.(
        params.durationSeconds,
        Date.now() - speedStartedAt,
        message,
      );
    result = {
      latency,
      downloadSpeed,
      latencySamples,
      speedSamples,
      jitterMs,
      packetLossPercent,
      testDurationSeconds,
      error: message,
      errorType: isDefenderBlockedError(message)
        ? "defender_blocked"
        : "generic",
    };
  } finally {
    params.onProgress("cleaning_up", 98, "正在清理全链路测试资源...");
    try {
      await sender.cleanup();
    } catch (error) {
      const cleanupError =
        error instanceof Error ? error.message : String(error);
      params.onLog(cleanupError, "error");
      result = {
        latency,
        downloadSpeed,
        latencySamples,
        speedSamples,
        jitterMs,
        packetLossPercent,
        testDurationSeconds,
        error: result.error ?? cleanupError,
        errorType: "generic",
        cleanupError,
      };
    } finally {
      params.signal.removeEventListener("abort", cancelLocalReceiver);
    }
  }
  if (!result.error) params.onProgress("completed", 100, "全链路测试完成");
  return result;
}
