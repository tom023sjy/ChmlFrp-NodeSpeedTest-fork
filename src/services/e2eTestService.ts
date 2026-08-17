/**
 * 端对端测试服务
 *
 * 测量 对端设备 → frp节点 → 本机(桌面客户端) 的真实链路延迟和带宽。
 *
 * 流程：
 *   1. 本机启动 TCP 测速服务端（start_tcp_speed_server）
 *   2. 本机创建临时隧道（tunnelService.createTempTunnel）并启动 frpc
 *   3. 通过 relay RPC 让对端设备执行 tcping / tcp_speed_test，
 *      连接本机的隧道地址（nodeIp:remotePort）
 *   4. 对端返回测速结果
 *   5. 清理资源（stop_frpc + deleteTempTunnel + stop_tcp_speed_server）
 *
 * 方向说明：
 *   - 「对端 → 本机」：本机作为服务端，对端作为客户端执行测速。
 *     所有设备类型（daemon / 桌面端）均支持。
 *   - 「本机 → 对端」：仅桌面端对端支持，需对端创建隧道+服务端。
 *     通过 relay 让对端桌面端执行相同流程，本机作为客户端测速。
 */

import { invoke } from "@tauri-apps/api/core";
import { tunnelService, type TempTunnelInfo } from "./tunnelService";
import { getStoredUser } from "./api";
import { getRelayClient, type RpcProgress } from "./deviceRelay";
import { isDefenderBlockedError } from "./speedTestService";
import type { TcpSpeedTestResult, TcpingResult } from "./relayHandlers";

/** 端对端测试方向 */
export type E2EDirection = "to_local" | "to_remote";

/** 端对端测试结果 */
export interface E2ETestResult {
  /** 延迟（毫秒），null 表示测试失败 */
  latencyMs: number | null;
  /** 下载速度（Mbps），null 表示未测或失败 */
  speedMbps: number | null;
  /** 测试方向描述 */
  directionLabel: string;
  /** 对端设备 ID */
  targetDeviceId: string;
  /** 对端设备名称 */
  targetDeviceName: string;
  /** 使用的节点名称 */
  nodeName: string;
  /** 错误信息 */
  error: string | null;
  /** 错误类型：defender_blocked 表示 Windows Defender 拦截 */
  errorType?: "defender_blocked" | "generic";
}

/** 进度回调 */
export interface E2EProgress {
  stage: string;
  progress: number;
  message: string;
  speedMbps?: number;
}

/** 测试选项 */
export interface E2ETestOptions {
  /** 对端设备 ID */
  targetDeviceId: string;
  /** 对端设备名称 */
  targetDeviceName: string;
  /** 对端设备类型 */
  targetDeviceType: "desktop" | "daemon";
  /** 节点名称 */
  nodeName: string;
  /** 测试方向 */
  direction: E2EDirection;
  /** 是否测试延迟 */
  testLatency: boolean;
  /** 是否测试带宽 */
  testSpeed: boolean;
  /** 测速时长（秒） */
  durationSeconds?: number;
  /** 进度回调 */
  onProgress?: (p: E2EProgress) => void;
  /** 日志回调 */
  onLog?: (
    msg: string,
    level?: "info" | "success" | "warning" | "error",
  ) => void;
}

/** 单个节点的批量测试结果 */
export interface BatchE2ENodeResult {
  nodeName: string;
  latencyMs: number | null;
  speedMbps: number | null;
  success: boolean;
  error: string | null;
  /** 错误类型：defender_blocked 表示 Windows Defender 拦截 */
  errorType?: "defender_blocked" | "generic";
}

/** 批量测试进度 */
export interface BatchE2EProgress {
  /** 当前节点序号（1-based） */
  current: number;
  /** 总节点数 */
  total: number;
  /** 当前节点名称 */
  currentNodeName: string;
  /** 阶段描述 */
  stage: string;
  /** 总体进度百分比 0-100 */
  overallPercent: number;
  /** 当前节点内部进度 0-100（用于节点级进度条） */
  nodeProgress?: number;
  /** 当前节点的附加消息（如实时速度） */
  nodeMessage?: string;
}

/** 测试中止控制器（支持软停止/取消停止/强制停止三态） */
export class E2ETestAbortController {
  private aborted = false;
  private forceAborted = false;
  /** 软停止：当前节点完成后停止后续节点 */
  abort() {
    this.aborted = true;
  }
  /** 取消软停止：恢复测试继续执行 */
  reset() {
    this.aborted = false;
  }
  /** 强制停止：立即中断当前节点 */
  forceAbort() {
    this.forceAborted = true;
    this.aborted = true;
  }
  get signal() {
    return { aborted: this.aborted, forceAborted: this.forceAborted };
  }
}

export class E2ETestService {
  private abortController: E2ETestAbortController | null = null;
  private tunnelInfo: TempTunnelInfo | null = null;
  private frpcStarted = false;

  /** 软停止：当前节点完成后停止后续节点 */
  abort() {
    this.abortController?.abort();
  }

  /** 取消软停止：恢复测试继续执行 */
  cancelAbort() {
    this.abortController?.reset();
  }

  /** 强制停止：立即中断当前节点测试 */
  forceAbort() {
    this.abortController?.forceAbort();
  }

  /** 是否已中止（软停止或强制停止） */
  get isAborted() {
    return this.abortController?.signal.aborted ?? false;
  }

  /** 是否强制停止 */
  get isForceAborted() {
    return this.abortController?.signal.forceAborted ?? false;
  }

  /**
   * 运行端对端测试
   */
  async runTest(options: E2ETestOptions): Promise<E2ETestResult> {
    const { direction, targetDeviceId, targetDeviceName, nodeName } = options;
    this.abortController = new E2ETestAbortController();

    const directionLabel =
      direction === "to_local"
        ? `${targetDeviceName} → 本机`
        : `本机 → ${targetDeviceName}`;

    const baseResult: E2ETestResult = {
      latencyMs: null,
      speedMbps: null,
      directionLabel,
      targetDeviceId,
      targetDeviceName,
      nodeName,
      error: null,
    };

    try {
      if (direction === "to_local") {
        return await this.runToLocalTest(options, baseResult);
      } else {
        return await this.runToRemoteTest(options, baseResult);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const errorType = isDefenderBlockedError(msg)
        ? ("defender_blocked" as const)
        : ("generic" as const);
      return { ...baseResult, error: msg, errorType };
    } finally {
      await this.cleanup(options.onLog);
    }
  }

  /**
   * 「对端 → 本机」方向测试
   * 本机创建隧道+测速服务端，对端通过 relay 执行测速命令
   */
  private async runToLocalTest(
    options: E2ETestOptions,
    baseResult: E2ETestResult,
  ): Promise<E2ETestResult> {
    const {
      onProgress,
      onLog,
      testLatency,
      testSpeed,
      durationSeconds = 15,
      targetDeviceId,
    } = options;
    const log = onLog ?? (() => {});
    const progress = onProgress ?? (() => {});

    // 1. 启动 TCP 测速服务端
    progress({
      stage: "starting_server",
      progress: 5,
      message: "正在启动测速服务端...",
    });
    log("正在启动 TCP 测速服务端...", "info");

    await invoke("stop_tcp_speed_server");
    const tcpServerPort = await invoke<number>("start_tcp_speed_server");
    log(`TCP 测速服务端已启动，端口: ${tcpServerPort}`, "success");

    const serverOk = await invoke<boolean>("check_tcp_speed_server", {
      port: tcpServerPort,
    });
    if (!serverOk) {
      throw new Error("TCP 测速服务端自检失败");
    }
    log("TCP 测速服务端自检通过", "success");

    if (this.isForceAborted) throw new Error("测试已强制停止");
    if (this.abortController?.signal.aborted) throw new Error("测试已取消");

    // 2. 创建临时隧道
    progress({
      stage: "creating_tunnel",
      progress: 15,
      message: "正在创建临时隧道...",
    });
    log(`正在创建临时隧道（节点: ${options.nodeName}）...`, "info");

    this.tunnelInfo = await tunnelService.createTempTunnel(
      tcpServerPort,
      options.nodeName,
    );
    log(
      `隧道创建成功: ${this.tunnelInfo.nodeIp}:${this.tunnelInfo.remotePort}`,
      "success",
    );

    if (this.isForceAborted) throw new Error("测试已强制停止");
    if (this.abortController?.signal.aborted) throw new Error("测试已取消");

    // 3. 启动 frpc
    progress({
      stage: "starting_frpc",
      progress: 25,
      message: "正在启动 frpc 客户端...",
    });
    log("正在启动 frpc...", "info");

    const user = getStoredUser();
    if (!user) throw new Error("请先登录");

    await invoke("start_frpc", {
      config: {
        server_addr: this.tunnelInfo.nodeIp,
        server_port: this.tunnelInfo.serverPort,
        user: user.usertoken,
        token: this.tunnelInfo.nodeToken,
        local_ip: "127.0.0.1",
        local_port: this.tunnelInfo.localPort,
        remote_port: this.tunnelInfo.remotePort,
        tunnel_name: this.tunnelInfo.tunnelName,
      },
    });
    this.frpcStarted = true;
    log("frpc 已启动，等待隧道连接...", "success");

    // 等待 frpc 连接建立
    await new Promise((resolve) => setTimeout(resolve, 3000));

    if (this.isForceAborted) throw new Error("测试已强制停止");
    if (this.abortController?.signal.aborted) throw new Error("测试已取消");

    const tunnelHost = this.tunnelInfo.nodeIp;
    const tunnelPort = this.tunnelInfo.remotePort;
    let latencyMs: number | null = null;
    let speedMbps: number | null = null;

    // 4. 延迟测试：让对端 tcping 本机隧道地址
    if (testLatency) {
      progress({
        stage: "testing_latency",
        progress: 35,
        message: `正在测试延迟（${options.targetDeviceName} → 本机）...`,
      });
      log(
        `正在通过 relay 让 ${options.targetDeviceName} 执行 tcping...`,
        "info",
      );

      const tcpingResp = await getRelayClient().sendRpc<TcpingResult>(
        targetDeviceId,
        "tcping",
        { host: tunnelHost, port: tunnelPort, count: 4 },
        { timeoutMs: 30000 },
      );

      if (tcpingResp.success && tcpingResp.data?.avg != null) {
        latencyMs = Math.round(tcpingResp.data.avg * 100) / 100;
        log(`延迟: ${latencyMs}ms`, "success");
      } else {
        log(
          `延迟测试失败: ${tcpingResp.error?.message ?? "未知错误"}`,
          "warning",
        );
      }
    }

    if (this.isForceAborted) throw new Error("测试已强制停止");
    if (this.abortController?.signal.aborted) throw new Error("测试已取消");

    // 5. 带宽测试：让对端 tcp_speed_test 本机隧道地址
    if (testSpeed) {
      progress({
        stage: "testing_speed",
        progress: 50,
        message: `正在测试带宽（${options.targetDeviceName} → 本机）...`,
      });
      log(
        `正在通过 relay 让 ${options.targetDeviceName} 执行带宽测试...`,
        "info",
      );

      const speedResp = await getRelayClient().sendRpc<TcpSpeedTestResult>(
        targetDeviceId,
        "tcp_speed_test",
        { host: tunnelHost, port: tunnelPort, durationSeconds },
        {
          timeoutMs: (durationSeconds + 30) * 1_000,
          onProgress: (p: RpcProgress) => {
            const pct = 50 + (p.progress / 100) * 45;
            progress({
              stage: "testing_speed",
              progress: pct,
              message: `带宽测试中... ${p.speedMbps?.toFixed(1) ?? ""} Mbps`,
              speedMbps: p.speedMbps,
            });
          },
        },
      );

      if (speedResp.success && speedResp.data?.success) {
        speedMbps = Math.round(speedResp.data.speedMbps * 100) / 100;
        log(`带宽: ${speedMbps} Mbps`, "success");
      } else {
        log(
          `带宽测试失败: ${speedResp.error?.message ?? speedResp.data?.error ?? "未知错误"}`,
          "warning",
        );
      }
    }

    progress({ stage: "completed", progress: 100, message: "测试完成" });

    return {
      ...baseResult,
      latencyMs,
      speedMbps,
      error: null,
    };
  }

  /**
   * 「本机 → 对端」方向测试
   * 通过 relay 让对端（桌面端或 daemon）创建隧道+服务端，本机执行测速命令
   * daemon 通过 e2e_setup / e2e_cleanup RPC 命令支持作为服务端
   */
  private async runToRemoteTest(
    options: E2ETestOptions,
    baseResult: E2ETestResult,
  ): Promise<E2ETestResult> {
    const {
      onProgress,
      onLog,
      testLatency,
      testSpeed,
      durationSeconds = 15,
      targetDeviceId,
      targetDeviceName,
    } = options;
    const log = onLog ?? (() => {});
    const progress = onProgress ?? (() => {});

    // 1. 通过 relay 让对端启动测速服务端 + 创建隧道 + 启动 frpc
    progress({
      stage: "remote_setup",
      progress: 10,
      message: `正在让 ${targetDeviceName} 准备测速环境...`,
    });
    log(`正在通过 relay 让 ${targetDeviceName} 准备测速环境...`, "info");

    const setupResp = await getRelayClient().sendRpc<{
      nodeIp: string;
      remotePort: number;
    }>(
      targetDeviceId,
      "e2e_setup",
      { nodeName: options.nodeName },
      { timeoutMs: 60000 },
    );

    if (!setupResp.success || !setupResp.data) {
      throw new Error(
        `对端准备测速环境失败: ${setupResp.error?.message ?? "未知错误"}`,
      );
    }

    const tunnelHost = setupResp.data.nodeIp;
    const tunnelPort = setupResp.data.remotePort;
    log(`对端隧道地址: ${tunnelHost}:${tunnelPort}`, "success");

    if (this.isForceAborted) throw new Error("测试已强制停止");
    if (this.abortController?.signal.aborted) throw new Error("测试已取消");

    let latencyMs: number | null = null;
    let speedMbps: number | null = null;

    // 2. 延迟测试：本机 tcping 对端隧道地址
    if (testLatency) {
      progress({
        stage: "testing_latency",
        progress: 35,
        message: `正在测试延迟（本机 → ${targetDeviceName}）...`,
      });
      log(`正在执行 tcping ${tunnelHost}:${tunnelPort}...`, "info");

      const tcpingResult = await invoke<{
        success: boolean;
        latency: number | null;
        error: string | null;
      }>("tcping_host", { host: tunnelHost, port: tunnelPort, timeout: 3 });

      if (tcpingResult.success && tcpingResult.latency != null) {
        latencyMs = Math.round(tcpingResult.latency * 100) / 100;
        log(`延迟: ${latencyMs}ms`, "success");
      } else {
        log(`延迟测试失败: ${tcpingResult.error ?? "未知错误"}`, "warning");
      }
    }

    if (this.isForceAborted) throw new Error("测试已强制停止");
    if (this.abortController?.signal.aborted) throw new Error("测试已取消");

    // 3. 带宽测试：本机 tcp_speed_test 对端隧道地址
    if (testSpeed) {
      progress({
        stage: "testing_speed",
        progress: 50,
        message: `正在测试带宽（本机 → ${targetDeviceName}）...`,
      });
      log(`正在执行带宽测试 ${tunnelHost}:${tunnelPort}...`, "info");

      const speedResult = await invoke<{
        success: boolean;
        speed_mbps: number;
        total_bytes: number;
        duration_ms: number;
        error: string | null;
      }>("tcp_speed_test", {
        host: tunnelHost,
        port: tunnelPort,
        durationSeconds,
      });

      if (speedResult.success) {
        speedMbps = Math.round(speedResult.speed_mbps * 100) / 100;
        log(`带宽: ${speedMbps} Mbps`, "success");
      } else {
        log(`带宽测试失败: ${speedResult.error ?? "未知错误"}`, "warning");
      }
    }

    // 4. 通知对端清理
    progress({
      stage: "remote_cleanup",
      progress: 95,
      message: "正在通知对端清理...",
    });
    await getRelayClient().sendRpc(
      targetDeviceId,
      "e2e_cleanup",
      {},
      { timeoutMs: 15000 },
    );

    progress({ stage: "completed", progress: 100, message: "测试完成" });

    return {
      ...baseResult,
      latencyMs,
      speedMbps,
      error: null,
    };
  }

  /**
   * 批量端对端测试：对同一个对端设备，逐个测试多个节点
   *
   * 每个节点独立创建/清理隧道资源，测试完一个再测下一个。
   * 支持中止：调用 abort() 后，当前节点测试完成后停止后续节点。
   */
  async runBatchTest(
    options: Omit<E2ETestOptions, "nodeName"> & {
      nodeNames: string[];
      onBatchProgress?: (p: BatchE2EProgress) => void;
    },
  ): Promise<BatchE2ENodeResult[]> {
    const { nodeNames, onBatchProgress, onLog, ...rest } = options;
    const log = onLog ?? (() => {});
    const batchProgress = onBatchProgress ?? (() => {});
    const total = nodeNames.length;
    const results: BatchE2ENodeResult[] = [];

    this.abortController = new E2ETestAbortController();

    log(`开始批量端对端测试，共 ${total} 个节点`, "info");

    for (let i = 0; i < total; i++) {
      // runTest 会重建 abortController，这里检查的是上一轮测试是否被中止
      if (this.isAborted) {
        log(`用户取消测试，已完成 ${i}/${total}`, "warning");
        break;
      }

      const nodeName = nodeNames[i];
      const overallPercent = ((i + 0.05) / total) * 100;
      batchProgress({
        current: i + 1,
        total,
        currentNodeName: nodeName,
        stage: "准备中",
        overallPercent,
      });

      log(`[${i + 1}/${total}] 开始测试节点: ${nodeName}`, "info");

      const result = await this.runTest({
        ...rest,
        nodeName,
        onLog,
        onProgress: (p) => {
          // 将单节点进度映射到总体进度（当前节点占 0.9 的范围，0.05 前后余量）
          const nodePct = i / total + (p.progress / 100) * (0.9 / total);
          batchProgress({
            current: i + 1,
            total,
            currentNodeName: nodeName,
            stage: p.message,
            overallPercent: Math.min(99, nodePct * 100),
            nodeProgress: p.progress,
            nodeMessage:
              p.speedMbps != null
                ? `${p.speedMbps.toFixed(1)} Mbps`
                : undefined,
          });
        },
      });

      const nodeResult: BatchE2ENodeResult = {
        nodeName,
        latencyMs: result.latencyMs,
        speedMbps: result.speedMbps,
        success: !result.error,
        error: result.error,
        errorType: result.errorType,
      };
      results.push(nodeResult);

      if (result.error) {
        log(`[${i + 1}/${total}] ${nodeName} 失败: ${result.error}`, "error");

        // 检测到 Windows Defender 拦截：立即停止整个测试流程
        if (result.errorType === "defender_blocked") {
          log(
            "检测到 Windows Defender 实时保护拦截，已自动停止测试",
            "warning",
          );
          this.abort();
          break;
        }
      } else {
        const latStr = result.latencyMs != null ? `${result.latencyMs}ms` : "-";
        const spdStr =
          result.speedMbps != null ? `${result.speedMbps}Mbps` : "-";
        log(
          `[${i + 1}/${total}] ${nodeName} 完成 - 延迟: ${latStr}, 带宽: ${spdStr}`,
          "success",
        );
      }
    }

    batchProgress({
      current: results.length,
      total,
      currentNodeName: "",
      stage: "完成",
      overallPercent: 100,
    });

    const successCount = results.filter((r) => r.success).length;
    log(
      this.isAborted
        ? `测试已停止: ${successCount}/${results.length} 成功`
        : `测试完成: ${successCount}/${total} 成功`,
      successCount === total ? "success" : "warning",
    );

    return results;
  }

  /** 清理本机资源 */
  private async cleanup(
    onLog?: (
      msg: string,
      level?: "info" | "success" | "warning" | "error",
    ) => void,
  ) {
    const log = onLog ?? (() => {});
    const errors: string[] = [];

    // 停止 frpc
    if (this.frpcStarted) {
      try {
        await invoke("stop_frpc");
        log("frpc 已停止", "info");
      } catch (e) {
        errors.push(
          `停止 frpc 失败: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      this.frpcStarted = false;
    }

    // 删除临时隧道
    if (this.tunnelInfo) {
      try {
        await tunnelService.deleteTempTunnel();
        log("临时隧道已删除", "info");
      } catch (e) {
        errors.push(
          `删除隧道失败: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      this.tunnelInfo = null;
    }

    // 兜底清理所有 speedtest 前缀的遗留隧道
    try {
      await tunnelService.cleanupAllTempTunnels();
    } catch {
      // 忽略
    }

    // 停止 TCP 测速服务端
    try {
      await invoke("stop_tcp_speed_server");
    } catch (e) {
      errors.push(
        `停止测速服务端失败: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    if (errors.length > 0) {
      log(`清理过程中有 ${errors.length} 个错误`, "warning");
    }
  }
}

export const e2eTestService = new E2ETestService();
