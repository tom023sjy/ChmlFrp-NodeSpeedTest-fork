import { runDirectedTunnelTest } from "./directedTunnelTestService";
import type { SpeedSample } from "./speedSamples";

export interface UnifiedTestEventHooks {
  onTunnelCreateSuccess?: (durationMs: number) => void;
  onTunnelCreateFailure?: (
    durationMs: number,
    errorCode: string,
    reason: string,
  ) => void;
  onFrpcStartSuccess?: (durationMs: number) => void;
  onFrpcStartFailure?: (
    durationMs: number,
    errorType: string,
    errorCode: string,
  ) => void;
  onLatencyTestSuccess?: (latencyMs: number, durationMs: number) => void;
  onLatencyTestFailure?: (durationMs: number, reason: string) => void;
  onSpeedTestSuccess?: (
    speedMbps: number,
    durationSeconds: number,
    durationMs: number,
  ) => void;
  onSpeedTestFailure?: (
    durationSeconds: number,
    durationMs: number,
    reason: string,
  ) => void;
}

export interface UnifiedTestParams {
  runId: string;
  signal: AbortSignal;
  senderDeviceId: string;
  senderDeviceName: string;
  receiverDeviceId: string;
  receiverDeviceName: string;
  nodeName: string;
  testLatency: boolean;
  testSpeed: boolean;
  durationSeconds: number;
  onLog: (
    msg: string,
    level?: "info" | "success" | "warning" | "error",
  ) => void;
  onProgress: (stage: string, progress: number, message: string) => void;
  events?: UnifiedTestEventHooks;
}

export interface UnifiedTestResult {
  latency: number | null;
  downloadSpeed: number | null;
  latencySamples: Array<number | null>;
  speedSamples: SpeedSample[];
  jitterMs: number | null;
  packetLossPercent: number | null;
  testDurationSeconds: number | null;
  error: string | null;
  errorType?: "defender_blocked" | "generic";
  cleanupError?: string;
}

export async function runUnifiedNodeTest(
  params: UnifiedTestParams,
): Promise<UnifiedTestResult> {
  return runDirectedTunnelTest(params);
}
