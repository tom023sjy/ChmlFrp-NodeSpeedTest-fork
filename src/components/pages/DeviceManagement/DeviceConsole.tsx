import { useState, useCallback } from "react";
import {
  ArrowLeft,
  Activity,
  Gauge,
  Play,
  Loader2,
  CheckCircle2,
  XCircle,
  Wifi,
  Clock,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import type { DeviceInfo } from "@/services/deviceApi";
import { getRelayClient } from "@/services/deviceRelay";
import type {
  NodeLatencyResult,
  SpeedtestResult,
} from "@/services/relayHandlers";

interface DeviceConsoleProps {
  device: DeviceInfo;
  onBack: () => void;
}

type TestTab = "latency" | "speedtest";

/** 将 RPC 错误码翻译为用户友好的提示文案 */
function formatRpcError(error: { code: string; message: string } | null): string {
  if (!error) return "测试失败";
  const { code, message } = error;
  const messages: Record<string, string> = {
    NOT_CONNECTED: "中继连接未就绪，请检查网络或重新登录",
    TIMEOUT: "目标设备响应超时，可能网络不畅或设备繁忙",
    TARGET_OFFLINE: "目标设备已离线",
    INTERCONNECT_DISABLED: "目标设备未开启互联",
    UNKNOWN_COMMAND: "目标设备不支持此命令（版本过低？）",
    INTERNAL_ERROR: "目标设备内部错误",
    NOT_SUPPORTED: "目标设备不支持此操作",
  };
  return messages[code] || message;
}

// 延迟测试状态
interface LatencyState {
  loading: boolean;
  result: NodeLatencyResult | null;
  error: string | null;
}

// 带宽测试状态
interface SpeedtestState {
  loading: boolean;
  progress: number;
  stage: string;
  currentSpeed: number;
  result: SpeedtestResult | null;
  error: string | null;
}

export function DeviceConsole({ device, onBack }: DeviceConsoleProps) {
  const [activeTab, setActiveTab] = useState<TestTab>("latency");

  // 延迟测试参数
  const [latencyNode, setLatencyNode] = useState("node1.chmlfrp.net");
  const [latencyPort, setLatencyPort] = useState(7000);
  const [latencyCount, setLatencyCount] = useState(4);
  const [latencyState, setLatencyState] = useState<LatencyState>({
    loading: false,
    result: null,
    error: null,
  });

  // 带宽测试参数
  const [speedtestUrl, setSpeedtestUrl] = useState("https://speed.cloudflare.com/__down?bytes=10000000");
  const [speedtestDirection, setSpeedtestDirection] = useState<"download" | "upload">("download");
  const [speedtestDuration, setSpeedtestDuration] = useState(10);
  const [speedtestState, setSpeedtestState] = useState<SpeedtestState>({
    loading: false,
    progress: 0,
    stage: "",
    currentSpeed: 0,
    result: null,
    error: null,
  });

  // 不可测速的设备状态
  const canTest = device.isOnline && device.interconnectEnabled;

  // ===== 延迟测试 =====
  const handleLatencyTest = useCallback(async () => {
    if (!canTest) {
      toast.error("设备离线或未开启互联");
      return;
    }

    setLatencyState({ loading: true, result: null, error: null });

    const relay = getRelayClient();
    try {
      const resp = await relay.sendRpc<NodeLatencyResult>(
        device.deviceId,
        "node_latency",
        { node: latencyNode, port: latencyPort, count: latencyCount },
      );

      if (resp.success && resp.data) {
        setLatencyState({ loading: false, result: resp.data, error: null });
        toast.success("延迟测试完成");
      } else {
        const errMsg = formatRpcError(resp.error);
        setLatencyState({ loading: false, result: null, error: errMsg });
        toast.error(errMsg);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setLatencyState({ loading: false, result: null, error: msg });
      toast.error(msg);
    }
  }, [canTest, device.deviceId, latencyNode, latencyPort, latencyCount]);

  // ===== 带宽测试 =====
  const handleSpeedtest = useCallback(async () => {
    if (!canTest) {
      toast.error("设备离线或未开启互联");
      return;
    }

    setSpeedtestState({
      loading: true,
      progress: 0,
      stage: "connecting",
      currentSpeed: 0,
      result: null,
      error: null,
    });

    const relay = getRelayClient();

    try {
      const resp = await relay.sendRpc<SpeedtestResult>(
        device.deviceId,
        "speedtest",
        {
          url: speedtestUrl,
          direction: speedtestDirection,
          durationSecs: speedtestDuration,
        },
        {
          onProgress: (p) => {
            setSpeedtestState((s) => ({
              ...s,
              progress: p.progress,
              stage: p.stage,
              currentSpeed: p.speedMbps ?? 0,
            }));
          },
        },
      );

      if (resp.success && resp.data) {
        setSpeedtestState({
          loading: false,
          progress: 100,
          stage: "completed",
          currentSpeed: resp.data.downloadSpeedMbps || resp.data.uploadSpeedMbps || 0,
          result: resp.data,
          error: null,
        });
        toast.success("带宽测试完成");
      } else {
        const errMsg = formatRpcError(resp.error);
        setSpeedtestState({
          loading: false,
          progress: 0,
          stage: "",
          currentSpeed: 0,
          result: null,
          error: errMsg,
        });
        toast.error(errMsg);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setSpeedtestState({
        loading: false,
        progress: 0,
        stage: "",
        currentSpeed: 0,
        result: null,
        error: msg,
      });
      toast.error(msg);
    }
  }, [canTest, device.deviceId, speedtestUrl, speedtestDirection, speedtestDuration]);

  return (
    <div className="flex h-full flex-col">
      {/* 顶部：返回按钮 + 设备信息 */}
      <div className="flex items-center gap-3 border-b border-border/40 px-6 py-4">
        <Button variant="ghost" size="sm" onClick={onBack} className="gap-1.5">
          <ArrowLeft className="h-4 w-4" />
          返回
        </Button>
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/10">
            <Activity className="h-5 w-5 text-primary" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-base font-semibold text-foreground">
                {device.deviceName || "未命名设备"}
              </h1>
              {device.isCurrent && <Badge variant="secondary" className="text-[10px]">本机</Badge>}
              {canTest ? (
                <Badge variant="outline" className="gap-1 border-emerald-500/30 text-emerald-600 dark:text-emerald-400">
                  <span className="inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
                  可远程
                </Badge>
              ) : (
                <Badge variant="outline" className="text-muted-foreground">
                  不可用
                </Badge>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              {device.osInfo || "未知"} · {device.hostname || "未知"}
            </p>
          </div>
        </div>
      </div>

      {/* Tab 切换 */}
      <div className="flex gap-1 border-b border-border/40 px-6 py-2">
        <button
          className={cn(
            "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors",
            activeTab === "latency"
              ? "bg-primary/10 text-primary"
              : "text-muted-foreground hover:text-foreground hover:bg-muted/50",
          )}
          onClick={() => setActiveTab("latency")}
        >
          <Zap className="h-4 w-4" />
          延迟测试
        </button>
        <button
          className={cn(
            "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors",
            activeTab === "speedtest"
              ? "bg-primary/10 text-primary"
              : "text-muted-foreground hover:text-foreground hover:bg-muted/50",
          )}
          onClick={() => setActiveTab("speedtest")}
        >
          <Gauge className="h-4 w-4" />
          带宽测试
        </button>
      </div>

      {/* 内容区 */}
      <div className="flex-1 overflow-auto px-6 py-4">
        {!canTest && (
          <div className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-700 dark:text-amber-400">
            {device.isOnline
              ? "该设备未开启互联，无法远程执行测试"
              : "该设备当前离线，无法远程执行测试"}
          </div>
        )}

        {activeTab === "latency" && (
          <LatencyTestPanel
            node={latencyNode}
            port={latencyPort}
            count={latencyCount}
            onNodeChange={setLatencyNode}
            onPortChange={setLatencyPort}
            onCountChange={setLatencyCount}
            onTest={handleLatencyTest}
            loading={latencyState.loading}
            result={latencyState.result}
            error={latencyState.error}
            disabled={!canTest}
          />
        )}

        {activeTab === "speedtest" && (
          <SpeedtestPanel
            url={speedtestUrl}
            direction={speedtestDirection}
            duration={speedtestDuration}
            onUrlChange={setSpeedtestUrl}
            onDirectionChange={setSpeedtestDirection}
            onDurationChange={setSpeedtestDuration}
            onTest={handleSpeedtest}
            state={speedtestState}
            disabled={!canTest}
          />
        )}
      </div>
    </div>
  );
}

// ===== 延迟测试面板 =====

interface LatencyTestPanelProps {
  node: string;
  port: number;
  count: number;
  onNodeChange: (v: string) => void;
  onPortChange: (v: number) => void;
  onCountChange: (v: number) => void;
  onTest: () => void;
  loading: boolean;
  result: NodeLatencyResult | null;
  error: string | null;
  disabled: boolean;
}

function LatencyTestPanel({
  node,
  port,
  count,
  onNodeChange,
  onPortChange,
  onCountChange,
  onTest,
  loading,
  result,
  error,
  disabled,
}: LatencyTestPanelProps) {
  return (
    <div className="space-y-4">
      {/* 参数配置 */}
      <div className="rounded-xl border border-border/40 p-4">
        <h3 className="mb-3 text-sm font-medium text-foreground">测试参数</h3>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label className="text-xs">节点地址</Label>
            <Input
              value={node}
              onChange={(e) => onNodeChange(e.target.value)}
              placeholder="node1.chmlfrp.net"
              disabled={disabled || loading}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">端口</Label>
            <Input
              type="number"
              value={port}
              onChange={(e) => onPortChange(Number(e.target.value) || 0)}
              disabled={disabled || loading}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">测试次数</Label>
            <Input
              type="number"
              value={count}
              min={1}
              max={20}
              onChange={(e) => onCountChange(Math.min(20, Math.max(1, Number(e.target.value) || 1)))}
              disabled={disabled || loading}
            />
          </div>
        </div>
        <div className="mt-3 flex justify-end">
          <Button onClick={onTest} disabled={disabled || loading} className="gap-1.5">
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            {loading ? "测试中..." : "开始测试"}
          </Button>
        </div>
      </div>

      {/* 错误提示 */}
      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          <XCircle className="h-4 w-4 flex-shrink-0" />
          {error}
        </div>
      )}

      {/* 测试结果 */}
      {result && (
        <div className="rounded-xl border border-border/40 p-4">
          <div className="mb-3 flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-emerald-500" />
            <h3 className="text-sm font-medium text-foreground">测试结果</h3>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {/* ICMP Ping 结果 */}
            <div className="rounded-lg bg-muted/30 p-3">
              <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <Wifi className="h-3.5 w-3.5" />
                ICMP Ping
              </div>
              <div className="space-y-1.5">
                <ResultRow label="平均延迟" value={result.ping.avg != null ? `${result.ping.avg.toFixed(1)} ms` : "-"} highlight />
                <ResultRow label="最小延迟" value={result.ping.min != null ? `${result.ping.min.toFixed(1)} ms` : "-"} />
                <ResultRow label="最大延迟" value={result.ping.max != null ? `${result.ping.max.toFixed(1)} ms` : "-"} />
                <ResultRow label="丢包率" value={`${((result.ping.loss / count) * 100).toFixed(0)}%`} />
                {result.ping.rtts.length > 0 && (
                  <div className="pt-1">
                    <span className="text-xs text-muted-foreground">每次延迟</span>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {result.ping.rtts.map((rtt, i) => (
                        <span key={i} className="rounded bg-background px-1.5 py-0.5 text-xs font-mono text-foreground">
                          {rtt.toFixed(1)}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* TCP Ping 结果 */}
            <div className="rounded-lg bg-muted/30 p-3">
              <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <Zap className="h-3.5 w-3.5" />
                TCP Ping
              </div>
              <div className="space-y-1.5">
                <ResultRow label="平均延迟" value={result.tcping.avg != null ? `${result.tcping.avg.toFixed(1)} ms` : "-"} highlight />
                <ResultRow label="丢包率" value={`${((result.tcping.loss / count) * 100).toFixed(0)}%`} />
                {result.tcping.rtts.length > 0 && (
                  <div className="pt-1">
                    <span className="text-xs text-muted-foreground">每次延迟</span>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {result.tcping.rtts.map((rtt, i) => (
                        <span key={i} className="rounded bg-background px-1.5 py-0.5 text-xs font-mono text-foreground">
                          {rtt.toFixed(1)}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ===== 带宽测试面板 =====

interface SpeedtestPanelProps {
  url: string;
  direction: "download" | "upload";
  duration: number;
  onUrlChange: (v: string) => void;
  onDirectionChange: (v: "download" | "upload") => void;
  onDurationChange: (v: number) => void;
  onTest: () => void;
  state: SpeedtestState;
  disabled: boolean;
}

function SpeedtestPanel({
  url,
  direction,
  duration,
  onUrlChange,
  onDirectionChange,
  onDurationChange,
  onTest,
  state,
  disabled,
}: SpeedtestPanelProps) {
  return (
    <div className="space-y-4">
      {/* 参数配置 */}
      <div className="rounded-xl border border-border/40 p-4">
        <h3 className="mb-3 text-sm font-medium text-foreground">测试参数</h3>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs">测速 URL</Label>
            <Input
              value={url}
              onChange={(e) => onUrlChange(e.target.value)}
              placeholder="https://speed.cloudflare.com/__down?bytes=10000000"
              disabled={disabled || state.loading}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">测试方向</Label>
              <div className="flex gap-1 rounded-lg bg-muted/30 p-1">
                <button
                  className={cn(
                    "flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                    direction === "download" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground",
                  )}
                  onClick={() => onDirectionChange("download")}
                  disabled={disabled || state.loading}
                >
                  下载
                </button>
                <button
                  className={cn(
                    "flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                    direction === "upload" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground",
                  )}
                  onClick={() => onDirectionChange("upload")}
                  disabled={disabled || state.loading}
                >
                  上传
                </button>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">持续时间（秒）</Label>
              <Input
                type="number"
                value={duration}
                min={5}
                max={60}
                onChange={(e) => onDurationChange(Math.min(60, Math.max(5, Number(e.target.value) || 10)))}
                disabled={disabled || state.loading}
              />
            </div>
          </div>
        </div>
        <div className="mt-3 flex justify-end">
          <Button onClick={onTest} disabled={disabled || state.loading} className="gap-1.5">
            {state.loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            {state.loading ? "测试中..." : "开始测试"}
          </Button>
        </div>
      </div>

      {/* 进度展示 */}
      {state.loading && (
        <div className="rounded-xl border border-border/40 p-4">
          <div className="mb-2 flex items-center justify-between text-sm">
            <span className="flex items-center gap-1.5 font-medium text-foreground">
              <Clock className="h-4 w-4 text-primary" />
              {stageLabel(state.stage)}
            </span>
            <span className="font-mono text-lg font-bold text-primary">
              {state.currentSpeed > 0 ? `${state.currentSpeed.toFixed(2)} Mbps` : "..."}
            </span>
          </div>
          {/* 进度条 */}
          <div className="h-2 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-all duration-300"
              style={{ width: `${state.progress}%` }}
            />
          </div>
          <div className="mt-1 text-right text-xs text-muted-foreground">
            {state.progress.toFixed(0)}%
          </div>
        </div>
      )}

      {/* 错误提示 */}
      {state.error && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          <XCircle className="h-4 w-4 flex-shrink-0" />
          {state.error}
        </div>
      )}

      {/* 测试结果 */}
      {state.result && (
        <div className="rounded-xl border border-border/40 p-4">
          <div className="mb-3 flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-emerald-500" />
            <h3 className="text-sm font-medium text-foreground">测试结果</h3>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-lg bg-muted/30 p-3 text-center">
              <div className="text-xs text-muted-foreground">下载速度</div>
              <div className="mt-1 text-2xl font-bold text-primary">
                {state.result.downloadSpeedMbps.toFixed(2)}
              </div>
              <div className="text-xs text-muted-foreground">Mbps</div>
            </div>
            <div className="rounded-lg bg-muted/30 p-3 text-center">
              <div className="text-xs text-muted-foreground">上传速度</div>
              <div className="mt-1 text-2xl font-bold text-primary">
                {state.result.uploadSpeedMbps.toFixed(2)}
              </div>
              <div className="text-xs text-muted-foreground">Mbps</div>
            </div>
          </div>
          {state.result.latencyMs != null && (
            <div className="mt-3 grid grid-cols-2 gap-3">
              <ResultRow label="延迟" value={`${state.result.latencyMs.toFixed(1)} ms`} />
              <ResultRow label="抖动" value={state.result.jitterMs != null ? `${state.result.jitterMs.toFixed(1)} ms` : "-"} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ===== 辅助组件 =====

function ResultRow({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={cn("text-sm font-medium", highlight ? "text-primary" : "text-foreground")}>
        {value}
      </span>
    </div>
  );
}

function stageLabel(stage: string): string {
  const labels: Record<string, string> = {
    connecting: "连接中...",
    downloading: "下载测速中",
    uploading: "上传测速中",
    completed: "已完成",
  };
  return labels[stage] || stage;
}
