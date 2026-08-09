/**
 * 端对端测试弹窗
 *
 * 选择对端设备 + 多个节点，批量测量 对端设备 → frp节点 → 本机（或反向）
 * 的真实链路延迟和带宽。
 *
 * 节点列表由外部传入（复用节点测试页的选中节点），弹窗内不再维护节点选择。
 * daemon 和桌面端均可作为服务端（to_remote 方向）。
 *
 * 状态管理模式复制自 BatchSpeedTestDialog：
 * - 模块级 globalE2EState 单例 + listeners 订阅
 * - 三态停止（停止/取消停止/强制停止）
 * - 最小化 + 浮窗联动
 */
import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Loader2,
  ArrowRightLeft,
  Server,
  Monitor,
  Gauge,
  Clock,
  CheckCircle2,
  XCircle,
  Info,
  AlertTriangle,
  Zap,
  ShieldAlert,
  ExternalLink,
  RotateCcw,
  Minimize2,
  SquareX,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { listDevices, type DeviceInfo } from "@/services/deviceApi";
import type { Node } from "@/services/api";
import {
  e2eTestService,
  type BatchE2ENodeResult,
  type BatchE2EProgress,
} from "@/services/e2eTestService";
import { getRelayClient } from "@/services/deviceRelay";

// ===== 全局状态 store（复制自 BatchSpeedTestDialog 的模式） =====

/** 端对端测试配置 */
interface E2ETestConfig {
  selectedDevice: string;
  direction: "to_local" | "to_remote";
  testLatency: boolean;
  testSpeed: boolean;
  sizeMb: number;
}

/** 日志条目 */
interface E2ELogEntry {
  message: string;
  level: "info" | "success" | "warning" | "error";
  time: string;
}

/** 全局测试状态（供浮窗和顶栏订阅） */
export interface E2ETestState {
  isRunning: boolean;
  isStopping: boolean;
  config: E2ETestConfig;
  progress: BatchE2EProgress | null;
  results: BatchE2ENodeResult[];
  logs: E2ELogEntry[];
}

let globalE2EState: E2ETestState = {
  isRunning: false,
  isStopping: false,
  config: {
    selectedDevice: "",
    direction: "to_local",
    testLatency: true,
    testSpeed: true,
    sizeMb: 10,
  },
  progress: null,
  results: [],
  logs: [],
};

const e2eListeners = new Set<() => void>();

function notifyE2EListeners() {
  e2eListeners.forEach((l) => l());
}

export function subscribeE2ETestState(listener: () => void): () => void {
  e2eListeners.add(listener);
  return () => {
    e2eListeners.delete(listener);
  };
}

export function getE2ETestState(): E2ETestState {
  return globalE2EState;
}

// 全局停止处理器：允许外部（如顶部停止按钮）触发弹窗内部的停止逻辑
let globalE2EStopHandler: (() => void) | null = null;
let globalE2EForceStopHandler: (() => void) | null = null;
let globalE2ECancelStopHandler: (() => void) | null = null;

export function requestStopE2ETest(): void {
  if (globalE2EStopHandler) {
    globalE2EStopHandler();
  }
}

export function requestForceStopE2ETest(): void {
  if (globalE2EForceStopHandler) {
    globalE2EForceStopHandler();
  }
}

export function requestCancelStopE2ETest(): void {
  if (globalE2ECancelStopHandler) {
    globalE2ECancelStopHandler();
  }
}

// ===== 组件 =====

interface E2ETestDialogProps {
  isOpen: boolean;
  onClose: (isMinimized?: boolean) => void;
  /** 外部传入的测试节点（复用节点测试页的选择） */
  nodes: Node[];
}

export function E2ETestDialog({ isOpen, onClose, nodes }: E2ETestDialogProps) {
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [config, setConfig] = useState<E2ETestConfig>(globalE2EState.config);
  const [progress, setProgress] = useState<BatchE2EProgress | null>(null);
  const [logs, setLogs] = useState<E2ELogEntry[]>([]);
  const [results, setResults] = useState<BatchE2ENodeResult[]>([]);
  const [relayConnected, setRelayConnected] = useState(false);
  const [showDefenderDialog, setShowDefenderDialog] = useState(false);
  // 软停止 / 强制停止 / 最小化 状态
  const [isStopping, setIsStopping] = useState(false);
  const [isForceStopping, setIsForceStopping] = useState(false);
  const [isMinimizing, setIsMinimizing] = useState(false);
  const stopRef = useRef(false);
  const isMinimizingRef = useRef(false);
  const logsEndRef = useRef<HTMLDivElement>(null);

  // 监听 relay 连接状态
  useEffect(() => {
    const relay = getRelayClient();
    setRelayConnected(relay.isConnected());
    const unlisten = relay.onConnectionChange((connected) => {
      setRelayConnected(connected);
    });
    return unlisten;
  }, []);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const deviceList = await listDevices();
      setDevices(deviceList.filter((d) => d.isOnline && !d.isCurrent));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "加载设备列表失败");
    } finally {
      setLoading(false);
    }
  }, []);

  // 打开弹窗时从全局状态同步（支持最小化后恢复）
  useEffect(() => {
    if (isOpen) {
      // 如果测试不在运行中，清除上次的日志和结果（全新开始）
      if (!globalE2EState.isRunning) {
        globalE2EState.logs = [];
        globalE2EState.results = [];
        globalE2EState.progress = null;
      }
      setProgress(globalE2EState.progress);
      setResults(globalE2EState.results);
      setLogs(globalE2EState.logs);
      setIsRunning(globalE2EState.isRunning);
      setConfig(globalE2EState.config);
      stopRef.current = false;
      setIsStopping(false);
      setIsForceStopping(false);
      setIsMinimizing(false);
      void loadData();
    }
  }, [isOpen, loadData]);

  useEffect(() => {
    if (logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [logs]);

  const addLog = useCallback(
    (message: string, level: "info" | "success" | "warning" | "error" = "info") => {
      const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
      const entry: E2ELogEntry = { message, level, time };
      globalE2EState.logs = [...globalE2EState.logs, entry];
      setLogs(globalE2EState.logs);
      notifyE2EListeners();
    },
    [],
  );

  // ===== 测试启动 =====
  const handleStartTest = useCallback(async () => {
    const targetDevice = devices.find((d) => d.deviceId === config.selectedDevice);
    if (!targetDevice) {
      toast.error("请选择对端设备");
      return;
    }
    if (nodes.length === 0) {
      toast.error("请先在节点列表中选择节点");
      return;
    }
    if (!config.testLatency && !config.testSpeed) {
      toast.error("请至少选择一项测试内容");
      return;
    }

    // 写入全局状态并广播
    globalE2EState.config = config;
    globalE2EState.isRunning = true;
    globalE2EState.isStopping = false;
    globalE2EState.results = [];
    globalE2EState.logs = [];
    globalE2EState.progress = null;
    notifyE2EListeners();

    setIsRunning(true);
    setResults([]);
    setLogs([]);
    stopRef.current = false;
    setIsStopping(false);
    setIsForceStopping(false);

    const nodeNames = nodes.map((n) => n.name);
    addLog(`开始端对端测试`, "info");
    addLog(`对端设备: ${targetDevice.deviceName} (${targetDevice.deviceType})`, "info");
    addLog(`节点数: ${nodeNames.length}`, "info");
    addLog(
      `方向: ${config.direction === "to_local" ? `${targetDevice.deviceName} → 本机` : `本机 → ${targetDevice.deviceName}`}`,
      "info",
    );

    const newResults: BatchE2ENodeResult[] = [];
    const total = nodeNames.length;

    try {
      // 逐个节点测试（runBatchTest 的逻辑内联，以便在循环中检查 stopRef）
      for (let i = 0; i < total; i++) {
        if (stopRef.current) {
          addLog(`用户取消测试，已完成 ${i}/${total}`, "warning");
          break;
        }

        const nodeName = nodeNames[i];
        const overallPercent = ((i + 0.05) / total) * 100;
        const nodeProgress: BatchE2EProgress = {
          current: i + 1,
          total,
          currentNodeName: nodeName,
          stage: "准备中",
          overallPercent,
        };
        globalE2EState.progress = nodeProgress;
        setProgress(nodeProgress);
        notifyE2EListeners();

        addLog(`[${i + 1}/${total}] 开始测试节点: ${nodeName}`, "info");

        const result = await e2eTestService.runTest({
          targetDeviceId: config.selectedDevice,
          targetDeviceName: targetDevice.deviceName,
          targetDeviceType: targetDevice.deviceType,
          nodeName,
          direction: config.direction,
          testLatency: config.testLatency,
          testSpeed: config.testSpeed,
          sizeMb: config.sizeMb,
          onLog: (msg, level) => addLog(msg, level),
          onProgress: (p) => {
            const nodePct = i / total + (p.progress / 100) * (0.9 / total);
            const progressData: BatchE2EProgress = {
              current: i + 1,
              total,
              currentNodeName: nodeName,
              stage: p.message,
              overallPercent: Math.min(99, nodePct * 100),
              nodeProgress: p.progress,
              nodeMessage: p.speedMbps != null ? `${p.speedMbps.toFixed(1)} Mbps` : undefined,
            };
            globalE2EState.progress = progressData;
            setProgress(progressData);
            notifyE2EListeners();
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
        newResults.push(nodeResult);

        if (result.error) {
          addLog(`[${i + 1}/${total}] ${nodeName} 失败: ${result.error}`, "error");

          // 检测到 Windows Defender 拦截：立即停止整个测试流程
          if (result.errorType === "defender_blocked") {
            addLog("检测到 Windows Defender 实时保护拦截，已自动停止测试", "warning");
            stopRef.current = true;
            setIsStopping(true);
            globalE2EState.isStopping = true;
            globalE2EState.results = [...newResults];
            setResults([...newResults]);
            notifyE2EListeners();
            setShowDefenderDialog(true);
            break;
          }
        } else {
          const latStr = result.latencyMs != null ? `${result.latencyMs}ms` : "-";
          const spdStr = result.speedMbps != null ? `${result.speedMbps}Mbps` : "-";
          addLog(`[${i + 1}/${total}] ${nodeName} 完成 - 延迟: ${latStr}, 带宽: ${spdStr}`, "success");
        }

        globalE2EState.results = [...newResults];
        setResults([...newResults]);
        notifyE2EListeners();
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      addLog(`测试异常: ${msg}`, "error");
      toast.error(msg);
    } finally {
      // 测试结束：重置全局状态并广播（修复"只能跑一次"的问题）
      globalE2EState.isRunning = false;
      globalE2EState.isStopping = false;
      globalE2EState.progress = null;
      setIsRunning(false);
      setProgress(null);
      setIsStopping(false);
      setIsForceStopping(false);
      notifyE2EListeners();

      const successCount = newResults.filter((r) => r.success).length;
      if (stopRef.current) {
        addLog(`测试已停止: ${successCount}/${newResults.length} 成功`, "warning");
        toast.warning(`测试已停止，${successCount}/${newResults.length} 成功`);
      } else {
        addLog(
          `测试完成: ${successCount}/${total} 成功`,
          successCount === total ? "success" : "warning",
        );
        toast.success(`端对端测试完成，${successCount}/${total} 成功`);
      }
    }
  }, [devices, config, nodes, addLog]);

  // ===== 三态停止 =====
  const handleStop = useCallback(() => {
    if (stopRef.current) return; // 防止重复点击
    stopRef.current = true;
    setIsStopping(true);
    globalE2EState.isStopping = true;
    notifyE2EListeners();
    e2eTestService.abort();
    addLog("将在当前节点测试完成后停止", "warning");
  }, [addLog]);

  const handleCancelStop = useCallback(() => {
    stopRef.current = false;
    setIsStopping(false);
    globalE2EState.isStopping = false;
    notifyE2EListeners();
    e2eTestService.cancelAbort();
    addLog("已取消停止，继续测试", "info");
  }, [addLog]);

  const handleForceStop = useCallback(() => {
    stopRef.current = true;
    setIsStopping(true);
    setIsForceStopping(true);
    globalE2EState.isStopping = true;
    notifyE2EListeners();
    e2eTestService.forceAbort();
    addLog("正在强制停止测试...", "warning");
  }, [addLog]);

  // 注册全局停止处理器，供外部（如顶部停止按钮）调用
  useEffect(() => {
    globalE2EStopHandler = handleStop;
    return () => {
      globalE2EStopHandler = null;
    };
  }, [handleStop]);

  useEffect(() => {
    globalE2EForceStopHandler = handleForceStop;
    return () => {
      globalE2EForceStopHandler = null;
    };
  }, [handleForceStop]);

  useEffect(() => {
    globalE2ECancelStopHandler = handleCancelStop;
    return () => {
      globalE2ECancelStopHandler = null;
    };
  }, [handleCancelStop]);

  // ===== 最小化 / 关闭 =====
  useEffect(() => {
    isMinimizingRef.current = isMinimizing;
  }, [isMinimizing]);

  const handleMinimize = useCallback(() => {
    isMinimizingRef.current = true;
    setIsMinimizing(true);
    onClose(true);
  }, [onClose]);

  const handleClose = useCallback(() => {
    if (isRunning) {
      // 运行中点击：触发停止（等当前节点完成），不关闭对话框
      handleStop();
      return;
    }
    // 非运行状态：清除日志后关闭
    globalE2EState.logs = [];
    setLogs([]);
    onClose();
  }, [isRunning, handleStop, onClose]);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open && !isMinimizingRef.current) {
        handleClose();
      }
      if (open) {
        setIsMinimizing(false);
      }
    },
    [handleClose],
  );

  const successCount = results.filter((r) => r.success).length;
  const failCount = results.filter((r) => !r.success).length;

  return (
    <>
      <Dialog open={isOpen} onOpenChange={handleOpenChange}>
        <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ArrowRightLeft className="h-5 w-5 text-primary" />
              端对端测试
            </DialogTitle>
            <DialogDescription>
              测量对端设备经 frp 节点到本机（或反向）的真实链路延迟和带宽
            </DialogDescription>
          </DialogHeader>

          {/* 连接状态检查 */}
          {!relayConnected && (
            <div className="flex items-center gap-2 rounded-lg border border-yellow-500/30 bg-yellow-500/5 p-3 text-sm text-yellow-700 dark:text-yellow-400">
              <XCircle className="h-4 w-4 flex-shrink-0" />
              中继连接未就绪，无法进行端对端测试
            </div>
          )}

          <div className="flex-1 overflow-y-auto flex flex-col gap-4 visible-scrollbar">
            {/* ===== 配置区（测试未开始或已结束时显示） ===== */}
            {!isRunning && results.length === 0 && (
              <>
                {/* 对端设备选择 */}
                <div className="space-y-2">
                  <Label className="text-sm font-medium">对端设备</Label>
                  {loading ? (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      加载设备列表...
                    </div>
                  ) : devices.length === 0 ? (
                    <div className="text-sm text-muted-foreground p-3 rounded-lg border border-dashed">
                      暂无其他在线设备
                    </div>
                  ) : (
                    <div className="grid grid-cols-2 gap-2">
                      {devices.map((d) => (
                        <button
                          key={d.deviceId}
                          onClick={() => setConfig((prev) => ({ ...prev, selectedDevice: d.deviceId }))}
                          disabled={isRunning}
                          className={cn(
                            "flex items-center gap-2 rounded-lg border p-3 text-left transition-colors",
                            config.selectedDevice === d.deviceId
                              ? "border-primary bg-primary/5"
                              : "border-border hover:bg-muted/30",
                          )}
                        >
                          {d.deviceType === "daemon" ? (
                            <Server className="h-4 w-4 flex-shrink-0 text-blue-500" />
                          ) : (
                            <Monitor className="h-4 w-4 flex-shrink-0 text-green-500" />
                          )}
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-medium">{d.deviceName}</div>
                            <div className="text-xs text-muted-foreground">{d.osInfo}</div>
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {/* 测试方向 */}
                <div className="space-y-2">
                  <Label className="text-sm font-medium">测试方向</Label>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setConfig((prev) => ({ ...prev, direction: "to_local" }))}
                      disabled={isRunning}
                      className={cn(
                        "flex-1 rounded-lg border p-3 text-sm transition-colors",
                        config.direction === "to_local"
                          ? "border-primary bg-primary/5"
                          : "border-border hover:bg-muted/30",
                      )}
                    >
                      <div className="font-medium">对端 → 本机</div>
                      <div className="text-xs text-muted-foreground mt-1">
                        对端作为客户端，测对端到本机的链路
                      </div>
                    </button>
                    <button
                      onClick={() => setConfig((prev) => ({ ...prev, direction: "to_remote" }))}
                      disabled={isRunning}
                      className={cn(
                        "flex-1 rounded-lg border p-3 text-sm transition-colors",
                        config.direction === "to_remote"
                          ? "border-primary bg-primary/5"
                          : "border-border hover:bg-muted/30",
                      )}
                    >
                      <div className="font-medium">本机 → 对端</div>
                      <div className="text-xs text-muted-foreground mt-1">
                        本机作为客户端，测本机到对端的链路
                      </div>
                    </button>
                  </div>
                </div>

                {/* 测试内容 */}
                <div className="space-y-3 p-4 border rounded-lg bg-muted/30">
                  <div className="flex items-center space-x-2">
                    <Checkbox
                      id="e2e-test-latency"
                      checked={config.testLatency}
                      onCheckedChange={(checked) => setConfig((prev) => ({ ...prev, testLatency: !!checked }))}
                      disabled={isRunning}
                    />
                    <label htmlFor="e2e-test-latency" className="text-sm cursor-pointer flex items-center gap-1.5">
                      <Clock className="h-3.5 w-3.5 text-muted-foreground" />
                      测试延迟
                    </label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <Checkbox
                      id="e2e-test-speed"
                      checked={config.testSpeed}
                      onCheckedChange={(checked) => setConfig((prev) => ({ ...prev, testSpeed: !!checked }))}
                      disabled={isRunning}
                    />
                    <label htmlFor="e2e-test-speed" className="text-sm cursor-pointer flex items-center gap-1.5">
                      <Gauge className="h-3.5 w-3.5 text-muted-foreground" />
                      测试带宽
                    </label>
                  </div>
                  {config.testSpeed && (
                    <div className="flex items-center gap-2 pl-6">
                      <label className="text-sm text-muted-foreground whitespace-nowrap">测试大小:</label>
                      <Input
                        type="number"
                        min={1}
                        max={100}
                        value={config.sizeMb}
                        onChange={(e) =>
                          setConfig((prev) => ({
                            ...prev,
                            sizeMb: Math.min(100, Math.max(1, Number(e.target.value) || 10)),
                          }))
                        }
                        disabled={isRunning}
                        className="w-20 h-8"
                      />
                      <span className="text-sm text-muted-foreground">MB</span>
                    </div>
                  )}
                </div>

                {/* 说明 */}
                <div className="p-3 bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 rounded-lg">
                  <div className="flex items-start gap-2">
                    <Info className="h-4 w-4 text-blue-600 flex-shrink-0 mt-0.5" />
                    <div className="text-xs text-blue-700 dark:text-blue-300">
                      <p className="font-medium mb-1">测试说明</p>
                      <p>• 对端 → 本机：本机创建隧道，对端执行测速</p>
                      <p>• 本机 → 对端：对端创建隧道，本机执行测速（daemon 也支持）</p>
                      <p>• 每个节点独立创建/清理隧道，逐个测试</p>
                    </div>
                  </div>
                </div>
              </>
            )}

            {/* ===== 批量测试进度区（含最小化按钮） ===== */}
            {isRunning && progress && (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Loader2 className="h-4 w-4 animate-spin text-primary" />
                    <span className="text-sm font-medium">
                      正在测试 ({progress.current}/{progress.total})
                    </span>
                  </div>
                  <Button size="sm" variant="ghost" onClick={handleMinimize} className="h-7 px-2">
                    <Minimize2 className="h-3.5 w-3.5 mr-1" />
                    最小化
                  </Button>
                </div>

                {/* 当前节点信息 */}
                <div className="p-3 bg-muted/50 rounded-lg space-y-2">
                  <div className="text-sm font-medium truncate">{progress.currentNodeName}</div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span>{progress.stage}</span>
                    {progress.nodeMessage && (
                      <>
                        <span>-</span>
                        <span>{progress.nodeMessage}</span>
                      </>
                    )}
                  </div>
                  {progress.nodeProgress != null && progress.nodeProgress > 0 && (
                    <div className="w-full bg-muted rounded-full h-1.5 overflow-hidden">
                      <div
                        className="bg-blue-500 h-full rounded-full transition-all duration-200"
                        style={{ width: `${progress.nodeProgress}%` }}
                      />
                    </div>
                  )}
                </div>

                {/* 总体进度条 */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>总体进度</span>
                    <span>
                      {progress.current}/{progress.total} ({progress.overallPercent.toFixed(1)}%)
                    </span>
                  </div>
                  <div className="w-full bg-muted rounded-full h-2.5 overflow-hidden">
                    <div
                      className="bg-primary h-full rounded-full transition-all duration-300 ease-out"
                      style={{ width: `${progress.overallPercent}%` }}
                    />
                  </div>
                </div>
              </div>
            )}

            {/* ===== 日志区 ===== */}
            {logs.length > 0 && (
              <div className="border rounded-lg p-3 bg-muted/30 max-h-40 overflow-y-auto flex-shrink-0 visible-scrollbar">
                <div className="text-xs font-medium text-muted-foreground mb-2">
                  日志 ({logs.length}){!isRunning && ` - 成功: ${successCount}, 失败: ${failCount}`}
                </div>
                <div className="space-y-1.5">
                  {logs.map((log, i) => {
                    const getIcon = () => {
                      switch (log.level) {
                        case "success":
                          return <CheckCircle2 className="w-3.5 h-3.5 text-green-500 flex-shrink-0" />;
                        case "error":
                          return <XCircle className="w-3.5 h-3.5 text-red-500 flex-shrink-0" />;
                        case "warning":
                          return <AlertTriangle className="w-3.5 h-3.5 text-yellow-500 flex-shrink-0" />;
                        default:
                          return <Info className="w-3.5 h-3.5 text-blue-500 flex-shrink-0" />;
                      }
                    };
                    const getColor = () => {
                      switch (log.level) {
                        case "success":
                          return "text-green-600";
                        case "error":
                          return "text-red-600";
                        case "warning":
                          return "text-yellow-600";
                        default:
                          return "text-muted-foreground";
                      }
                    };
                    return (
                      <div key={i} className={cn("flex items-start gap-2 text-xs", getColor())}>
                        {getIcon()}
                        <span className="break-all">{log.message}</span>
                      </div>
                    );
                  })}
                  <div ref={logsEndRef} />
                </div>
              </div>
            )}

            {/* ===== 结果列表 ===== */}
            {!isRunning && results.length > 0 && (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  {failCount === 0 ? (
                    <>
                      <CheckCircle2 className="h-5 w-5 text-green-500" />
                      <span className="text-sm font-medium text-green-600 dark:text-green-400">
                        测试完成: {successCount}/{results.length} 成功
                      </span>
                    </>
                  ) : (
                    <>
                      <AlertTriangle className="h-5 w-5 text-yellow-500" />
                      <span className="text-sm font-medium text-yellow-600 dark:text-yellow-400">
                        测试完成: {successCount} 成功, {failCount} 失败
                      </span>
                    </>
                  )}
                </div>
                <div className="max-h-60 overflow-y-auto rounded-lg border border-border/40 visible-scrollbar">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-muted/80 backdrop-blur-sm">
                      <tr>
                        <th className="text-left px-3 py-2 font-medium text-xs text-muted-foreground">节点</th>
                        <th className="text-right px-3 py-2 font-medium text-xs text-muted-foreground">延迟</th>
                        <th className="text-right px-3 py-2 font-medium text-xs text-muted-foreground">带宽</th>
                        <th className="text-center px-3 py-2 font-medium text-xs text-muted-foreground">状态</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border/50">
                      {results.map((r, i) => (
                        <tr key={i} className="hover:bg-muted/30">
                          <td className="px-3 py-2 truncate max-w-[160px]" title={r.nodeName}>
                            {r.nodeName}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">
                            {r.latencyMs != null ? (
                              <span
                                className={
                                  r.latencyMs < 100
                                    ? "text-green-600"
                                    : r.latencyMs < 300
                                      ? "text-yellow-600"
                                      : "text-red-600"
                                }
                              >
                                {r.latencyMs}ms
                              </span>
                            ) : (
                              <span className="text-muted-foreground">-</span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">
                            {r.speedMbps != null ? (
                              <span
                                className={
                                  r.speedMbps >= 50
                                    ? "text-green-600"
                                    : r.speedMbps >= 10
                                      ? "text-yellow-600"
                                      : "text-red-600"
                                }
                              >
                                {r.speedMbps}Mbps
                              </span>
                            ) : (
                              <span className="text-muted-foreground">-</span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-center">
                            {r.success ? (
                              <CheckCircle2 className="w-4 h-4 text-green-500 inline-block" />
                            ) : (
                              <XCircle className="w-4 h-4 text-red-500 inline-block" />
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {/* 失败详情 */}
                {results.some((r) => r.error) && (
                  <div className="space-y-1">
                    {results
                      .filter((r) => r.error)
                      .map((r, i) => (
                        <div
                          key={i}
                          className="flex items-start gap-1.5 text-xs text-red-600 dark:text-red-400"
                        >
                          <XCircle className="w-3 h-3 flex-shrink-0 mt-0.5" />
                          <span className="break-all">
                            {r.nodeName}: {r.error}
                          </span>
                        </div>
                      ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* 操作按钮：三态（停止中/运行中/已完成） */}
          <div className="flex justify-end gap-2 mt-4 pt-4 border-t">
            {isRunning && isStopping ? (
              <>
                <Button variant="outline" onClick={handleCancelStop} disabled={isForceStopping}>
                  取消停止
                </Button>
                <Button variant="destructive" onClick={handleForceStop} disabled={isForceStopping}>
                  {isForceStopping ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                      正在停止...
                    </>
                  ) : (
                    <>
                      <SquareX className="h-4 w-4 mr-1.5" />
                      强制停止
                    </>
                  )}
                </Button>
              </>
            ) : (
              <Button variant="outline" onClick={handleClose} disabled={isStopping}>
                {isRunning ? "停止" : "关闭"}
              </Button>
            )}
            {!isRunning && results.length === 0 && (
              <Button
                onClick={() => void handleStartTest()}
                disabled={
                  !config.selectedDevice ||
                  nodes.length === 0 ||
                  !relayConnected ||
                  (!config.testLatency && !config.testSpeed)
                }
                className="gap-1.5"
              >
                <Zap className="h-4 w-4" />
                开始测试 ({nodes.length})
              </Button>
            )}
            {!isRunning && results.length > 0 && (
              <Button onClick={() => void handleStartTest()} className="gap-1.5">
                <RotateCcw className="h-4 w-4" />
                重新测试
              </Button>
            )}
          </div>
        </DialogContent>

        {/* Windows Defender 实时保护拦截 frpc 提示弹窗 */}
        <Dialog open={showDefenderDialog} onOpenChange={setShowDefenderDialog}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <ShieldAlert className="h-5 w-5 text-red-600" />
                测试已被 Windows Defender 拦截
              </DialogTitle>
              <DialogDescription>
                Windows Defender 的「实时保护」阻止了 frpc 启动，测试流程已自动停止。
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-3 text-sm">
              <div className="flex items-start gap-2 p-3 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 rounded-lg">
                <AlertTriangle className="h-4 w-4 text-red-600 flex-shrink-0 mt-0.5" />
                <div className="text-red-700 dark:text-red-300 space-y-1">
                  <p className="font-medium">原因：文件包含病毒或潜在的垃圾软件 (os error 225)</p>
                  <p className="text-xs">frpc 是 ChmlFrp 官方提供的内网穿透工具，被 Defender 误报为威胁并拦截。</p>
                </div>
              </div>

              <div className="space-y-2">
                <p className="font-medium">处理步骤：</p>
                <ol className="list-decimal list-inside space-y-1 text-muted-foreground text-xs ml-1">
                  <li>点击下方按钮打开「病毒和威胁防护」设置</li>
                  <li>将「实时保护」开关关闭（临时关闭即可）</li>
                  <li>返回本软件重新发起测试</li>
                </ol>
              </div>

              <div className="flex items-start gap-2 p-2 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-md">
                <Info className="h-3.5 w-3.5 text-amber-600 flex-shrink-0 mt-0.5" />
                <p className="text-xs text-amber-700 dark:text-amber-300">
                  实时保护关闭期间系统防护会降低。Windows 通常会在短时间内自动重新开启实时保护；若需立即恢复，可再次点击下方按钮手动开启。
                </p>
              </div>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => setShowDefenderDialog(false)}>
                稍后处理
              </Button>
              <Button
                variant="outline"
                onClick={async () => {
                  try {
                    await invoke("open_system_url", { url: "windowsdefender://threatsettings/" });
                  } catch (err) {
                    console.error("打开 Windows 安全中心失败:", err);
                  }
                }}
              >
                <ExternalLink className="h-4 w-4 mr-1.5" />
                打开病毒和威胁防护
              </Button>
              <Button
                onClick={() => {
                  setShowDefenderDialog(false);
                  void handleStartTest();
                }}
              >
                <RotateCcw className="h-4 w-4 mr-1.5" />
                已关闭，重新测试
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </Dialog>
    </>
  );
}
