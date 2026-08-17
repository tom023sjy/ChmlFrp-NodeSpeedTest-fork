import { useState, useCallback, useEffect, useRef } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { AlertCircle, CheckCircle2, Loader2, Info, AlertTriangle, Zap, Minimize2, SquareX, ShieldAlert, ExternalLink, RotateCcw } from "lucide-react";
import type { LogEntry } from "@/services/speedTestService";
import { runUnifiedNodeTest, type UnifiedTestResult } from "@/services/unifiedTestService";
import { TestRunController } from "@/services/testRunController";
import { invoke } from "@tauri-apps/api/core";
import { reportUsage } from "@/services/backendApi";
import { getStoredUser } from "@/services/api";
import {
  getStoredDurationSeconds,
  setStoredDurationSeconds,
} from "@/services/nodeTestPreferences";
import {
  resolveBatchTestCompletion,
  shouldClearBatchTestArtifacts,
} from "@/services/batchTestCompletion";
import { calculateBatchOverallPercent } from "@/services/batchTestProgress";

/** 根据发送端/接收端是否为本机，返回设备对类型，用于事件 eventData */
function pairTypeOf(senderId: string, receiverId: string): string {
  const s = senderId === "local" ? "local" : "remote";
  const r = receiverId === "local" ? "local" : "remote";
  return `${s}_to_${r}`;
}

/** 仅在用户已登录时上报使用量事件，失败静默不影响主流程 */
function reportUsageIfLoggedIn(eventType: string, eventData?: Record<string, unknown>): void {
  if (!getStoredUser()?.accessToken) return;
  reportUsage({ eventType, eventData }).catch(() => {});
}

interface TestConfig {
  testLatency: boolean;
  testSpeed: boolean;
  durationSeconds: number;
  senderDeviceId: string;   // "local" 表示本机
  senderDeviceName: string;
  receiverDeviceId: string;  // "local" 表示本机
  receiverDeviceName: string;
}

export interface NodeResult {
  nodeName: string;
  latency?: number;
  downloadSpeed?: number;
  error?: string;
  success: boolean;
  details?: UnifiedTestResult;
  logs: LogEntry[];
}

export interface BatchTestState {
  isRunning: boolean;
  isStopping: boolean;
  preserveLogs: boolean;
  config: TestConfig;
  nodeNames: string[];
  progress: {
    current: number;
    total: number;
    currentNodeName: string;
    stage: string;
    rawStage: string;
    nodeProgress?: number;
    nodeMessage?: string;
    overallPercent: number;
  } | null;
  results: NodeResult[];
  logs: LogEntry[];
}

const globalState: BatchTestState = {
  isRunning: false,
  isStopping: false,
  preserveLogs: false,
  config: { testLatency: true, testSpeed: true, durationSeconds: getStoredDurationSeconds(localStorage), senderDeviceId: "local", senderDeviceName: "本机", receiverDeviceId: "local", receiverDeviceName: "本机" },
  nodeNames: [],
  progress: null,
  results: [],
  logs: [],
};

const listeners = new Set<() => void>();

function notifyListeners() {
  listeners.forEach(l => l());
}

export function subscribeBatchTestState(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getBatchTestState(): BatchTestState {
  return globalState;
}

// 全局停止处理器：允许外部（如顶部停止按钮）触发 SpeedTestDialog 内部的停止逻辑
let globalStopHandler: (() => void) | null = null;
// 全局强制停止处理器：立即中断当前节点测试
let globalForceStopHandler: (() => void) | null = null;
// 全局取消停止处理器：取消软停止，继续测试
let globalCancelStopHandler: (() => void) | null = null;

export function requestStopBatchTest(): void {
  if (globalStopHandler) {
    globalStopHandler();
  }
}

export function requestForceStopBatchTest(): void {
  if (globalForceStopHandler) {
    globalForceStopHandler();
  }
}

export function requestCancelStopBatchTest(): void {
  if (globalCancelStopHandler) {
    globalCancelStopHandler();
  }
}

const stageLabels: Record<string, string> = {
  idle: "准备中",
  creating_tunnel: "创建隧道",
  starting_frpc: "启动frpc",
  connecting: "等待连接",
  testing_latency: "测试延迟",
  testing_speed: "测试速度",
  cleaning_up: "清理资源",
  completed: "完成",
  error: "错误",
};

function LogItem({ log }: { log: LogEntry }) {
  const getIcon = () => {
    switch (log.type) {
      case "success":
        return <CheckCircle2 className="w-3.5 h-3.5 text-green-500 flex-shrink-0" />;
      case "error":
        return <AlertCircle className="w-3.5 h-3.5 text-red-500 flex-shrink-0" />;
      case "warning":
        return <AlertTriangle className="w-3.5 h-3.5 text-yellow-500 flex-shrink-0" />;
      default:
        return <Info className="w-3.5 h-3.5 text-blue-500 flex-shrink-0" />;
    }
  };

  const getTextColor = () => {
    switch (log.type) {
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
    <div className={`flex items-start gap-2 text-xs ${getTextColor()}`}>
      {getIcon()}
      <span className="break-all">{log.message}</span>
    </div>
  );
}

interface SpeedTestDialogProps {
  isOpen: boolean;
  onClose: (isMinimized?: boolean) => void;
  nodeNames: string[];
  /** 外部传入的设备对（发送端/接收端），由调用方在顶栏设置，弹窗内不再编辑 */
  pair?: { senderId: string; senderName: string; receiverId: string; receiverName: string };
  onTestComplete?: (results: Map<string, NodeResult>, pair: { senderId: string; receiverId: string; senderName: string; receiverName: string }, shouldShowLogs: boolean) => void;
}

export function SpeedTestDialog({ isOpen, onClose, nodeNames, pair, onTestComplete }: SpeedTestDialogProps) {
  const [config, setConfig] = useState<TestConfig>(globalState.config);
  const [isRunning, setIsRunning] = useState(false);
  const [durationSecondsInput, setDurationSecondsInput] = useState<string>(config.durationSeconds.toString());
  const [progress, setProgress] = useState<BatchTestState["progress"]>(null);
  const [results, setResults] = useState<NodeResult[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const runControllerRef = useRef<TestRunController | null>(null);
  const logsEndRef = useRef<HTMLDivElement>(null);
  const onTestCompleteRef = useRef(onTestComplete);

  useEffect(() => {
    onTestCompleteRef.current = onTestComplete;
  }, [onTestComplete]);

  useEffect(() => {
    if (logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [logs]);

  useEffect(() => {
    if (isOpen) {
      // 打开对话框时，如果测试不在运行中，清除上次的日志和结果（全新开始）
      if (shouldClearBatchTestArtifacts(globalState.isRunning, globalState.preserveLogs)) {
        globalState.logs = [];
        globalState.results = [];
        globalState.progress = null;
      }
      setProgress(globalState.progress);
      setResults(globalState.results);
      setLogs(globalState.logs);
      setIsRunning(globalState.isRunning);
      // 同步外部传入的设备对到 config（发送端/接收端由顶栏设置，弹窗内不再编辑）
      if (pair) {
        globalState.config = {
          ...globalState.config,
          senderDeviceId: pair.senderId,
          senderDeviceName: pair.senderName,
          receiverDeviceId: pair.receiverId,
          receiverDeviceName: pair.receiverName,
        };
      }
      setConfig(globalState.config);
      if (!globalState.isRunning) {
        runControllerRef.current = null;
        setIsStopping(false);
        setIsForceStopping(false);
      }
      setIsMinimizing(false);
      setDurationSecondsInput(globalState.config.durationSeconds.toString());
    }
  }, [isOpen, pair]);

  useEffect(() => {
    setDurationSecondsInput(config.durationSeconds.toString());
  }, [config.durationSeconds]);

  const addLog = useCallback((message: string, type: LogEntry["type"] = "info") => {
    const entry: LogEntry = { timestamp: Date.now(), message, type };
    globalState.logs = [...globalState.logs, entry];
    setLogs(globalState.logs);
    notifyListeners();
  }, []);

  const handleStartTest = useCallback(async () => {
    if (!config.testLatency && !config.testSpeed) {
      return;
    }

    globalState.config = config;
    globalState.isRunning = true;
    globalState.isStopping = false;
    globalState.preserveLogs = false;
    globalState.results = [];
    globalState.logs = [];
    globalState.progress = null;
    notifyListeners();

    setIsRunning(true);
    setResults([]);
    setLogs([]);
    const runController = new TestRunController(crypto.randomUUID());
    runControllerRef.current = runController;
    setIsStopping(false);
    setIsForceStopping(false);

    addLog(`开始测试，共 ${nodeNames.length} 个节点`, "info");
    addLog(`配置: 延迟测试=${config.testLatency ? "是" : "否"}, 速度测试=${config.testSpeed ? "是" : "否"}${config.testSpeed ? `, 时长=${config.durationSeconds}秒` : ""}`, "info");

    // 节点测试开始埋点：仅在用户已登录时上报
    reportUsageIfLoggedIn("node_test_start", {
      total_count: nodeNames.length,
      test_latency: config.testLatency,
      test_speed: config.testSpeed,
      speed_duration_seconds: config.durationSeconds,
      pair_type: pairTypeOf(config.senderDeviceId, config.receiverDeviceId),
    });

    const newResults: NodeResult[] = [];
    const total = nodeNames.length;
    const batchStart = Date.now();

    for (let i = 0; i < nodeNames.length; i++) {
      if (runController.shouldStopBatch()) {
        break;
      }

      const nodeName = nodeNames[i];
      const nodeLogStart = globalState.logs.length;
      const overallPercent = calculateBatchOverallPercent(i, total, 0);
      const nodeProgress = { current: i + 1, total, currentNodeName: nodeName, stage: "准备中", rawStage: "idle", overallPercent };
      globalState.progress = nodeProgress;
      setProgress(nodeProgress);
      notifyListeners();

      addLog(`[${i + 1}/${total}] 开始测试节点: ${nodeName}`, "info");

      const nodeStart = Date.now();
      try {
        const result: UnifiedTestResult = await runUnifiedNodeTest({
          runId: runController.runId,
          signal: runController.signal,
          senderDeviceId: config.senderDeviceId,
          senderDeviceName: config.senderDeviceName,
          receiverDeviceId: config.receiverDeviceId,
          receiverDeviceName: config.receiverDeviceName,
          nodeName,
          testLatency: config.testLatency,
          testSpeed: config.testSpeed,
          durationSeconds: config.durationSeconds,
          onLog: (msg, level) => addLog(msg, level),
          onProgress: (stage, progress, message) => {
            const stageLabel = stageLabels[stage as keyof typeof stageLabels] || stage;
            const completedNodes = i;
            const overallPercent = calculateBatchOverallPercent(completedNodes, total, progress);
            const progressData = {
              current: i + 1,
              total,
              currentNodeName: nodeName,
              stage: stageLabel,
              rawStage: stage,
              nodeProgress: progress,
              nodeMessage: message,
              overallPercent,
            };
            globalState.progress = progressData;
            setProgress(progressData);
            notifyListeners();
          },
          events: {
            onTunnelCreateSuccess: (durationMs) => reportUsageIfLoggedIn("tunnel_create_success", { duration_ms: durationMs, pair_type: pairTypeOf(config.senderDeviceId, config.receiverDeviceId) }),
            onTunnelCreateFailure: (durationMs, errorCode) => reportUsageIfLoggedIn("tunnel_create_failure", { duration_ms: durationMs, error_code: errorCode, pair_type: pairTypeOf(config.senderDeviceId, config.receiverDeviceId) }),
            onFrpcStartSuccess: (durationMs) => reportUsageIfLoggedIn("frpc_start_success", { duration_ms: durationMs, pair_type: pairTypeOf(config.senderDeviceId, config.receiverDeviceId) }),
            onFrpcStartFailure: (durationMs, errorType, errorCode) => reportUsageIfLoggedIn("frpc_start_failure", { duration_ms: durationMs, error_type: errorType, error_code: errorCode, pair_type: pairTypeOf(config.senderDeviceId, config.receiverDeviceId) }),
            onLatencyTestSuccess: (latencyMs, durationMs) => reportUsageIfLoggedIn("latency_test_success", { latency_ms: latencyMs, duration_ms: durationMs, pair_type: pairTypeOf(config.senderDeviceId, config.receiverDeviceId) }),
            onLatencyTestFailure: (durationMs) => reportUsageIfLoggedIn("latency_test_failure", { duration_ms: durationMs, pair_type: pairTypeOf(config.senderDeviceId, config.receiverDeviceId) }),
            onSpeedTestSuccess: (speedMbps, durationSeconds, durationMs) => reportUsageIfLoggedIn("speed_test_success", { speed_mbps: speedMbps, duration_seconds: durationSeconds, duration_ms: durationMs, pair_type: pairTypeOf(config.senderDeviceId, config.receiverDeviceId) }),
            onSpeedTestFailure: (durationSeconds, durationMs) => reportUsageIfLoggedIn("speed_test_failure", { duration_seconds: durationSeconds, duration_ms: durationMs, pair_type: pairTypeOf(config.senderDeviceId, config.receiverDeviceId) }),
          },
        });

        if (runController.isForceStopping()) {
          addLog(
            result.cleanupError
              ? `[${i + 1}/${total}] ${nodeName} 已中止，但资源回收失败: ${result.cleanupError}`
              : `[${i + 1}/${total}] ${nodeName} 已中止，资源回收完成`,
            result.cleanupError ? "error" : "warning",
          );
          break;
        }

        const nodeDuration = Date.now() - nodeStart;
        if (!result.error) {
          const nodeResult: NodeResult = {
            nodeName,
            latency: result.latency ?? undefined,
            downloadSpeed: result.downloadSpeed ?? undefined,
            success: true,
            details: result,
            logs: [],
          };
          newResults.push(nodeResult);

          const latencyStr = result.latency != null ? `${result.latency.toFixed(0)}ms` : "-";
          const speedStr = result.downloadSpeed != null ? `${result.downloadSpeed.toFixed(2)}Mbps` : "-";
          addLog(`[${i + 1}/${total}] ${nodeName} 完成 - 延迟: ${latencyStr}, 速度: ${speedStr}`, "success");

          // 单节点测试成功埋点
          reportUsageIfLoggedIn("node_test_node_success", {
            test_latency: config.testLatency,
            test_speed: config.testSpeed,
            latency_ms: result.latency ?? null,
            download_mbps: result.downloadSpeed ?? null,
            duration_ms: nodeDuration,
            pair_type: pairTypeOf(config.senderDeviceId, config.receiverDeviceId),
          });
        } else {
          const nodeResult: NodeResult = {
            nodeName,
            error: result.error,
            success: false,
            details: result,
            logs: [],
          };
          newResults.push(nodeResult);
          addLog(`[${i + 1}/${total}] ${nodeName} 失败: ${result.error}`, "error");

          // 单节点测试失败埋点
          reportUsageIfLoggedIn("node_test_node_failure", {
            error_type: result.errorType ?? "generic",
            duration_ms: nodeDuration,
            pair_type: pairTypeOf(config.senderDeviceId, config.receiverDeviceId),
          });

          // Windows Defender 拦截 frpc：作为可靠的安全软件拦截事件上报
          if (result.errorType === "defender_blocked") {
            reportUsageIfLoggedIn("speed_test_defender_blocked", {
              pair_type: pairTypeOf(config.senderDeviceId, config.receiverDeviceId),
            });
            addLog("检测到 Windows Defender 实时保护拦截，已自动停止测速", "warning");
            runController.requestStop();
            setIsStopping(true);
            globalState.isStopping = true;
            globalState.results = [...newResults];
            setResults([...newResults]);
            notifyListeners();
            setShowDefenderDialog(true);
            break;
          }
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : "测试失败";
        if (runController.isForceStopping()) {
          addLog(`[${i + 1}/${total}] ${nodeName} 已中止，资源回收完成`, "warning");
          break;
        }
        const nodeResult: NodeResult = {
          nodeName,
          error: errorMsg,
          success: false,
          logs: [],
        };
        newResults.push(nodeResult);
        addLog(`[${i + 1}/${total}] ${nodeName} 异常: ${errorMsg}`, "error");

        // 异常路径单节点失败埋点
        reportUsageIfLoggedIn("node_test_node_failure", {
          error_type: "generic",
          duration_ms: Date.now() - nodeStart,
          pair_type: pairTypeOf(config.senderDeviceId, config.receiverDeviceId),
        });

        // 异常路径也检测 Defender 拦截特征（invoke 抛错时）
        if (/os error 225|0x800700e1|病毒|垃圾软件|file contains a virus|potentially unwanted software/i.test(errorMsg)) {
          reportUsageIfLoggedIn("speed_test_defender_blocked", {
            pair_type: pairTypeOf(config.senderDeviceId, config.receiverDeviceId),
          });
          runController.requestStop();
          setIsStopping(true);
          globalState.isStopping = true;
          globalState.results = [...newResults];
          setResults([...newResults]);
          notifyListeners();
          setShowDefenderDialog(true);
          break;
        }
      }

      const completedResult = newResults.at(-1);
      if (completedResult?.nodeName === nodeName) {
        completedResult.logs = globalState.logs.slice(nodeLogStart);
      }

      globalState.results = [...newResults];
      setResults([...newResults]);
      notifyListeners();
    }

    const successCount = newResults.filter(r => r.success).length;
    const stopped = runController.shouldStopBatch();
    const forceStopped = runController.isForceStopping();
    const completion = resolveBatchTestCompletion(total, successCount, stopped, forceStopped);
    if (forceStopped) {
      addLog(`测试已强制停止: 已完成 ${newResults.length}/${total} 个节点，${successCount} 成功`, "warning");
    } else if (stopped) {
      addLog(`测试已停止: 已完成 ${newResults.length}/${total} 个节点，${successCount} 成功`, "warning");
    } else {
      addLog(`测试完成: ${successCount}/${total} 成功`, completion.allSucceeded ? "success" : "warning");
    }

    globalState.isRunning = false;
    globalState.isStopping = false;
    globalState.preserveLogs = completion.shouldShowLogs;
    globalState.progress = null;
    globalState.results = [...newResults];
    setIsRunning(false);
    setProgress(null);
    setIsStopping(false);
    setIsForceStopping(false);
    setResults([...newResults]);
    notifyListeners();

    if (onTestCompleteRef.current) {
      const resultMap = new Map<string, NodeResult>();
      newResults.forEach(r => {
        resultMap.set(r.nodeName, r);
      });
      try {
        onTestCompleteRef.current(resultMap, {
          senderId: config.senderDeviceId,
          receiverId: config.receiverDeviceId,
          senderName: config.senderDeviceName,
          receiverName: config.receiverDeviceName,
        }, completion.shouldShowLogs);
      } catch {
        addLog("测速结果保存失败，请保留日志后重试", "error");
        onClose(true);
      }
    }

    // 节点测试完成埋点：统计整批结果，仅在用户已登录时上报
    reportUsageIfLoggedIn("node_test_complete", {
      total_count: total,
      success_count: successCount,
      failure_count: newResults.length - successCount,
      duration_ms: Date.now() - batchStart,
      stopped_by_user: runController.shouldStopBatch(),
      test_latency: config.testLatency,
      test_speed: config.testSpeed,
      speed_duration_seconds: config.durationSeconds,
      pair_type: pairTypeOf(config.senderDeviceId, config.receiverDeviceId),
    });
  }, [nodeNames, config, addLog, onClose]);

  const [isMinimizing, setIsMinimizing] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const isMinimizingRef = useRef(false);
  const [isForceStopping, setIsForceStopping] = useState(false);
  // Windows Defender 拦截 frpc 后的提示弹窗
  const [showDefenderDialog, setShowDefenderDialog] = useState(false);

  const handleStop = useCallback(() => {
    const controller = runControllerRef.current;
    if (!controller || controller.shouldStopBatch()) return;
    controller.requestStop();
    setIsStopping(true);
    globalState.isStopping = true;
    notifyListeners();
    addLog("将在当前节点测试完成后停止", "warning");
  }, [addLog]);

  const handleCancelStop = useCallback(() => {
    const controller = runControllerRef.current;
    if (!controller || controller.isForceStopping()) return;
    controller.cancelStop();
    setIsStopping(false);
    globalState.isStopping = false;
    notifyListeners();
    addLog("已取消停止，继续测试", "info");
  }, [addLog]);

  const handleForceStop = useCallback(() => {
    const controller = runControllerRef.current;
    if (!controller || controller.isForceStopping()) return;
    controller.forceStop();
    setIsStopping(true);
    setIsForceStopping(true);
    globalState.isStopping = true;
    notifyListeners();
    addLog("正在强制停止测速并回收资源，请勿关闭弹窗...", "warning");
  }, [addLog]);

  // 注册全局停止处理器，供外部（如顶部停止按钮）调用
  useEffect(() => {
    globalStopHandler = handleStop;
    return () => { globalStopHandler = null; };
  }, [handleStop]);

  // 注册全局强制停止处理器
  useEffect(() => {
    globalForceStopHandler = handleForceStop;
    return () => { globalForceStopHandler = null; };
  }, [handleForceStop]);

  // 注册全局取消停止处理器
  useEffect(() => {
    globalCancelStopHandler = handleCancelStop;
    return () => { globalCancelStopHandler = null; };
  }, [handleCancelStop]);

  const handleClose = useCallback(() => {
    if (isForceStopping) return;
    if (isRunning) {
      // 运行中点击：触发停止（等当前节点完成），不关闭对话框
      handleStop();
      return;
    }
    // 非运行状态：清除日志后关闭
    globalState.logs = [];
    globalState.preserveLogs = false;
    setLogs([]);
    onClose();
  }, [isForceStopping, isRunning, handleStop, onClose]);

  useEffect(() => {
    isMinimizingRef.current = isMinimizing;
  }, [isMinimizing]);

  const handleMinimize = useCallback(() => {
    if (isForceStopping) return;
    isMinimizingRef.current = true;
    setIsMinimizing(true);
    onClose(true);
  }, [isForceStopping, onClose]);

  const handleOpenChange = useCallback((open: boolean) => {
    if (!open && !isMinimizingRef.current && !isForceStopping) {
      if (isRunning) {
        // 测速运行中点击弹窗外部：自动最小化（不停止测试）
        handleMinimize();
        return;
      }
      handleClose();
    }
    if (open) {
      setIsMinimizing(false);
    }
  }, [handleClose, handleMinimize, isRunning, isForceStopping]);

  const successCount = results.filter(r => r.success).length;
  const failCount = results.filter(r => !r.success).length;

  const renderConfigPanel = () => (
    <>
    <div className="space-y-4 p-4 border rounded-lg bg-muted/30">
      <div className="space-y-3">
        <div className="flex items-center space-x-2">
          <Checkbox
            id="testLatency"
            checked={config.testLatency}
            onCheckedChange={(checked) =>
              setConfig(prev => ({ ...prev, testLatency: !!checked }))
            }
          />
          <label htmlFor="testLatency" className="text-sm cursor-pointer">
            测试延迟
          </label>
        </div>

        <div className="flex items-center space-x-2">
          <Checkbox
            id="testSpeed"
            checked={config.testSpeed}
            onCheckedChange={(checked) =>
              setConfig(prev => ({ ...prev, testSpeed: !!checked }))
            }
          />
          <label htmlFor="testSpeed" className="text-sm cursor-pointer">
            测试下载速度
          </label>
        </div>

        {config.testSpeed && (
          <div className="flex items-center gap-2 pl-6">
            <label className="text-sm text-muted-foreground whitespace-nowrap">
              测试时长:
            </label>
            <Input
              type="number"
              min={5}
              max={120}
              value={durationSecondsInput}
              onChange={(e) =>
                setDurationSecondsInput(e.target.value)
              }
              onBlur={(e) => {
                const value = e.target.value;
                const parsedValue = value === "" ? 15 : parseInt(value) || 15;
                const finalValue = Math.max(5, Math.min(120, parsedValue));
                setConfig(prev => ({ ...prev, durationSeconds: finalValue }));
                setStoredDurationSeconds(localStorage, finalValue);
                setDurationSecondsInput(finalValue.toString());
              }}
              className="w-20 h-8"
            />
            <span className="text-sm text-muted-foreground">秒</span>
          </div>
        )}
      </div>

      <div className="p-3 bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 rounded-lg">
        <div className="flex items-start gap-2">
          <Info className="w-4 h-4 text-blue-600 flex-shrink-0 mt-0.5" />
          <div className="text-xs text-blue-700 dark:text-blue-300">
            <p className="font-medium mb-1">测试说明</p>
            <p>• 仅测试延迟：直连节点7000端口，无需隧道配额</p>
            <p>• 包含速度测试：需要创建隧道，请确保至少有1个空闲配额</p>
            <p className="mt-1">测试将逐个节点进行，每个节点会用时15-30秒，具体时间取决于本机环境和节点质量。</p>
          </div>
        </div>
      </div>
    </div>
    </>
  );

  const renderBatchRunning = () => {
    const overallProgress = progress!.overallPercent;

    return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin text-primary" />
          <span className="text-sm font-medium">
            正在测试 ({progress!.current}/{progress!.total})
          </span>
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={handleMinimize}
          className="h-7 px-2"
        >
          <Minimize2 className="w-3.5 h-3.5 mr-1" />
          最小化
        </Button>
      </div>

      <div className="p-3 bg-muted/50 rounded-lg space-y-2">
        <div className="text-sm font-medium truncate">{progress!.currentNodeName}</div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>{progress!.stage}</span>
          {progress!.nodeMessage && (
            <>
              <span>-</span>
              <span>{progress!.nodeMessage}</span>
            </>
          )}
        </div>
        {progress!.nodeProgress != null && progress!.nodeProgress > 0 && (
          <div className="w-full bg-muted rounded-full h-1.5 overflow-hidden">
            <div
              className="bg-blue-500 h-full rounded-full transition-all duration-200"
              style={{ width: `${progress!.nodeProgress}%` }}
            />
          </div>
        )}
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>总体进度</span>
          <span>{progress!.current}/{progress!.total} ({overallProgress.toFixed(1)}%)</span>
        </div>
        <div className="w-full bg-muted rounded-full h-2.5 overflow-hidden">
          <div
            className="bg-primary h-full rounded-full transition-all duration-300 ease-out"
            style={{ width: `${overallProgress}%` }}
          />
        </div>
      </div>
    </div>
  );
  };

  return (
    <>
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Zap className="w-5 h-5" />
            {nodeNames.length === 1 ? "节点测试" : "批量测试"}
            {config.senderDeviceId !== "local" || config.receiverDeviceId !== "local" ? (
              <span className="text-xs text-muted-foreground font-normal">
                {config.senderDeviceName} → {config.receiverDeviceName}
              </span>
            ) : null}
          </DialogTitle>
          <DialogDescription>
            {nodeNames.length === 1 ? `节点: ${nodeNames[0]}` : `共 ${nodeNames.length} 个节点`}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto flex flex-col gap-4 visible-scrollbar">
          {!isRunning && results.length === 0 && renderConfigPanel()}

          {isRunning && progress && renderBatchRunning()}

          {logs.length > 0 && (
            <div className="border rounded-lg p-3 bg-muted/30 max-h-40 overflow-y-auto flex-shrink-0 visible-scrollbar">
              <div className="text-xs font-medium text-muted-foreground mb-2">
                日志 ({logs.length}){!isRunning && ` - 成功: ${successCount}, 失败: ${failCount}`}
              </div>
              <div className="space-y-1.5">
                {logs.map((log, index) => (
                  <LogItem key={index} log={log} />
                ))}
                <div ref={logsEndRef} />
              </div>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 mt-4 pt-4 border-t">
          {isRunning && isStopping ? (
            <>
              <Button variant="outline" onClick={handleCancelStop} disabled={isForceStopping}>
                取消停止
              </Button>
              <Button variant="destructive" onClick={handleForceStop} disabled={isForceStopping}>
                {isForceStopping ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
                    正在停止...
                  </>
                ) : (
                  <>
                    <SquareX className="w-4 h-4 mr-1.5" />
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
              onClick={handleStartTest}
              disabled={!config.testLatency && !config.testSpeed}
            >
              <Zap className="w-4 h-4 mr-1.5" />
              开始测试
            </Button>
          )}
          {!isRunning && results.length > 0 && (
            <Button onClick={handleStartTest}>
              重新测试
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>

    {/* Windows Defender 实时保护拦截 frpc 提示弹窗 */}
    <Dialog open={showDefenderDialog} onOpenChange={(open) => setShowDefenderDialog(open)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldAlert className="w-5 h-5 text-red-600" />
            测速已被 Windows Defender 拦截
          </DialogTitle>
          <DialogDescription>
            Windows Defender 的「实时保护」阻止了 frpc 启动，测速流程已自动停止。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 text-sm">
          <div className="flex items-start gap-2 p-3 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 rounded-lg">
            <AlertTriangle className="w-4 h-4 text-red-600 flex-shrink-0 mt-0.5" />
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
              <li>返回本软件重新发起测速</li>
            </ol>
          </div>

          <div className="flex items-start gap-2 p-2 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-md">
            <Info className="w-3.5 h-3.5 text-amber-600 flex-shrink-0 mt-0.5" />
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
                // 调用后端命令打开 windowsdefender:// 协议（opener 插件默认不允许此协议）
                await invoke("open_system_url", { url: "windowsdefender://threatsettings/" });
              } catch (err) {
                console.error("打开 Windows 安全中心失败:", err);
              }
            }}
          >
            <ExternalLink className="w-4 h-4 mr-1.5" />
            打开病毒和威胁防护
          </Button>
          <Button
            onClick={() => {
              setShowDefenderDialog(false);
              handleStartTest();
            }}
          >
            <RotateCcw className="w-4 h-4 mr-1.5" />
            已关闭，重新测速
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  );
}
