/**
 * Daemon 远程管理面板
 *
 * 通过 WebSocket 中继对 daemon 设备进行远程运维：
 * - 服务控制：启动 / 停止 / 重启 / 状态查看
 * - 更新管理：版本检查、执行更新、自动更新开关
 * - 日志查看：拉取最近 N 行日志
 *
 * 账号与后端地址配置由服务端安装/登录流程管理，不在此面板控制。
 *
 * 风格与 DeviceConsole.tsx 保持一致。
 */
import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import {
  Power,
  RefreshCw,
  Loader2,
  CheckCircle2,
  XCircle,
  Play,
  Square,
  RotateCw,
  Terminal,
  DownloadCloud,
  ArrowUpCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Select } from "@/components/ui/select";
import { toast } from "sonner";
import {
  daemonServiceControl,
  daemonGetLogs,
  daemonCheckUpdate,
  daemonPerformUpdate,
  daemonGetUpdateSettings,
  daemonSetAutoUpdate,
  type ServiceStatus,
  type UpdateCheckResult,
  type UpdateSettings,
  type DaemonLogs,
} from "@/services/daemonManage";
import { reportUsage } from "@/services/backendApi";
import { getStoredUser } from "@/services/api";

interface DaemonManagePanelProps {
  deviceId: string;
}

/** 已登录时上报事件，失败静默处理 */
function reportUsageIfLoggedIn(eventType: string, eventData?: Record<string, unknown>): void {
  if (!getStoredUser()?.accessToken) return;
  reportUsage({ eventType, eventData }).catch(() => {});
}

/** 通用错误提示块 */
function ErrorBlock({ message }: { message: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 backdrop-blur-sm p-3 text-sm text-destructive">
      <XCircle className="h-4 w-4 flex-shrink-0" />
      {message}
    </div>
  );
}

export function DaemonManagePanel({ deviceId }: DaemonManagePanelProps) {
  return (
    <Tabs defaultValue="service" className="w-full">
      <TabsList className="h-9">
        <TabsTrigger value="service" className="gap-1.5">
          <Power className="h-3.5 w-3.5" />
          服务控制
        </TabsTrigger>
        <TabsTrigger value="update" className="gap-1.5">
          <ArrowUpCircle className="h-3.5 w-3.5" />
          更新管理
        </TabsTrigger>
        <TabsTrigger value="logs" className="gap-1.5">
          <Terminal className="h-3.5 w-3.5" />
          日志查看
        </TabsTrigger>
      </TabsList>

      <TabsContent value="service">
        <ServiceTab deviceId={deviceId} />
      </TabsContent>
      <TabsContent value="update">
        <UpdateTab deviceId={deviceId} />
      </TabsContent>
      <TabsContent value="logs">
        <LogsTab deviceId={deviceId} />
      </TabsContent>
    </Tabs>
  );
}

// ===== 服务控制 Tab =====

export function ServiceTab({ deviceId }: { deviceId: string }) {
  const [status, setStatus] = useState<ServiceStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const inFlightRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /**
   * 拉取服务状态。
   * silent = true 用于 5 秒自动轮询：不显示 loading、失败保留最后一次成功状态且不打扰用户；
   * silent = false 用于首次加载和操作后刷新：显示 loading 与错误。
   */
  const refresh = useCallback(async (silent = false) => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    if (!silent) {
      setLoading(true);
      setError(null);
    }
    try {
      const s = await daemonServiceControl(deviceId, "status");
      if (!mountedRef.current) return;
      setStatus(s);
    } catch (e) {
      if (!mountedRef.current) return;
      const msg = e instanceof Error ? e.message : "获取状态失败";
      if (!silent) {
        setError(msg);
        // 获取服务状态失败（确认为真实失败）
        reportUsageIfLoggedIn("service_status_view", { result: "failure", reason: msg });
      }
    } finally {
      inFlightRef.current = false;
      if (!silent && mountedRef.current) setLoading(false);
    }
  }, [deviceId]);

  // 进入页面立即查询，之后每 5 秒静默自动刷新
  useEffect(() => {
    void refresh(false);
    const timer = window.setInterval(() => {
      void refresh(true);
    }, 5000);
    return () => {
      window.clearInterval(timer);
    };
  }, [refresh]);

  const handleAction = async (action: "start" | "stop" | "restart") => {
    setActionLoading(action);
    try {
      await daemonServiceControl(deviceId, action);
      toast.success(
        action === "start" ? "服务已启动" : action === "stop" ? "服务已停止" : "服务已重启",
      );
      // 服务控制命令成功（daemon 确认执行 = 真实成功）
      const successEvent =
        action === "start" ? "service_start_success" : action === "stop" ? "service_stop_success" : "service_restart_success";
      reportUsageIfLoggedIn(successEvent, {});
      await refresh();
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      toast.error(e instanceof Error ? e.message : "操作失败");
      // 服务控制命令失败（确认为真实失败）
      const failureEvent =
        action === "start" ? "service_start_failure" : action === "stop" ? "service_stop_failure" : "service_restart_failure";
      reportUsageIfLoggedIn(failureEvent, { reason });
    } finally {
      setActionLoading(null);
    }
  };

  if (loading) {
    return (
      <div className="flex h-40 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {error && <ErrorBlock message={error} />}

      {/* 服务状态 */}
      <div className="rounded-xl border border-border/40 bg-muted/20 backdrop-blur-md p-4">
        <div className="mb-3 flex items-center gap-2">
          <Power className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-medium text-foreground">服务状态</h3>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-lg bg-background/40 backdrop-blur-sm p-3">
            <div className="text-xs text-muted-foreground">运行状态</div>
            <div className="mt-1 flex items-center gap-1.5">
              {status?.active ? (
                <>
                  <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                  <span className="text-sm font-medium text-emerald-600 dark:text-emerald-400">
                    运行中
                  </span>
                </>
              ) : (
                <>
                  <XCircle className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm font-medium text-muted-foreground">已停止</span>
                </>
              )}
            </div>
          </div>
          <div className="rounded-lg bg-background/40 backdrop-blur-sm p-3">
            <div className="text-xs text-muted-foreground">开机自启</div>
            <div className="mt-1 flex items-center gap-1.5">
              {status?.enabled ? (
                <Badge variant="outline" className="gap-1 border-emerald-500/30 text-emerald-600 dark:text-emerald-400">
                  已启用
                </Badge>
              ) : (
                <Badge variant="outline" className="text-muted-foreground">
                  已禁用
                </Badge>
              )}
            </div>
          </div>
        </div>

        {status?.statusText && (
          <div className="mt-3 rounded-lg bg-background/30 backdrop-blur-sm p-2">
            <p className="font-mono text-xs text-muted-foreground">{status.statusText}</p>
          </div>
        )}
        {status?.pid != null && (
          <div className="mt-2 text-xs text-muted-foreground">PID: {status.pid}</div>
        )}
      </div>

      {/* 操作按钮 */}
      <div className="rounded-xl border border-border/40 bg-muted/20 backdrop-blur-md p-4">
        <h3 className="mb-3 text-sm font-medium text-foreground">服务操作</h3>
        <div className="grid grid-cols-3 gap-2">
          <Button
            variant="outline"
            onClick={() => handleAction("start")}
            disabled={actionLoading !== null || status?.active === true}
            className="gap-1.5"
          >
            {actionLoading === "start" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Play className="h-4 w-4" />
            )}
            启动
          </Button>
          <Button
            variant="outline"
            onClick={() => handleAction("stop")}
            disabled={actionLoading !== null || status?.active !== true}
            className="gap-1.5"
          >
            {actionLoading === "stop" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Square className="h-4 w-4" />
            )}
            停止
          </Button>
          <Button
            variant="outline"
            onClick={() => handleAction("restart")}
            disabled={actionLoading !== null}
            className="gap-1.5"
          >
            {actionLoading === "restart" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RotateCw className="h-4 w-4" />
            )}
            重启
          </Button>
        </div>
      </div>
    </div>
  );
}

// ===== 更新管理 Tab =====

export function UpdateTab({ deviceId }: { deviceId: string }) {
  const [settings, setSettings] = useState<UpdateSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [checkResult, setCheckResult] = useState<UpdateCheckResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [togglingAuto, setTogglingAuto] = useState(false);
  // 更新过程日志和进度
  const [updateLogs, setUpdateLogs] = useState<string[]>([]);
  const [updateProgress, setUpdateProgress] = useState(0);
  const logsEndRef = useRef<HTMLDivElement>(null);

  const loadSettings = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const s = await daemonGetUpdateSettings(deviceId);
      setSettings(s);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "加载更新设置失败";
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [deviceId]);

  const loadUpdateData = useCallback(async () => {
    setLoading(true);
    setChecking(true);
    setError(null);
    const [settingsResult, updateResult] = await Promise.allSettled([
      daemonGetUpdateSettings(deviceId),
      daemonCheckUpdate(deviceId),
    ]);
    const errors: string[] = [];
    if (settingsResult.status === "fulfilled") {
      setSettings(settingsResult.value);
    } else {
      errors.push(
        settingsResult.reason instanceof Error
          ? settingsResult.reason.message
          : "加载更新设置失败",
      );
    }
    if (updateResult.status === "fulfilled") {
      setCheckResult(updateResult.value);
    } else {
      errors.push(
        updateResult.reason instanceof Error
          ? updateResult.reason.message
          : "检查更新失败",
      );
    }
    setError(errors.length > 0 ? errors.join("；") : null);
    setChecking(false);
    setLoading(false);
  }, [deviceId]);

  useEffect(() => {
    void loadUpdateData();
  }, [loadUpdateData]);

  // 日志自动滚动到底部
  useEffect(() => {
    if (logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [updateLogs]);

  // 检查更新
  const handleCheck = async (silent = false) => {
    setChecking(true);
    setError(null);
    try {
      const result = await daemonCheckUpdate(deviceId);
      setCheckResult(result);
      // 远程更新检查成功（确认为真实结果）
      reportUsageIfLoggedIn("remote_update_check", {
        has_update: result.hasUpdate,
        latest_version: result.latestVersion || null,
      });
      if (result.hasUpdate && !silent) {
        toast.success(`发现新版本：${result.latestVersion}`);
        // 发现远程更新
        reportUsageIfLoggedIn("remote_update_available", {
          latest_version: result.latestVersion || null,
        });
      } else if (!silent) {
        toast.info("当前已是最新版本");
      }
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      if (silent) {
        setError(reason || "检查更新失败");
      } else {
        toast.error(e instanceof Error ? e.message : "检查更新失败");
      }
      // 远程更新检查失败（确认为真实失败）
      reportUsageIfLoggedIn("remote_update_check", { result: "failure", reason });
    } finally {
      setChecking(false);
    }
  };

  // 执行更新（实时显示进度日志）
  const handleUpdate = async () => {
    setUpdating(true);
    setUpdateLogs([]);
    setUpdateProgress(0);
    // 远程更新安装开始（确认为真实用户意图）
    reportUsageIfLoggedIn("remote_update_install_start", {
      latest_version: checkResult?.latestVersion || null,
    });
    try {
      await daemonPerformUpdate(deviceId, (p) => {
        if (p.stage) {
          const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
          setUpdateLogs((prev) => [...prev, `[${time}] ${p.stage}`]);
        }
        if (p.progress != null) {
          setUpdateProgress(p.progress);
        }
      });
      setUpdateProgress(100);
      toast.success("更新已完成");
      setCheckResult(null);
      // 远程更新安装成功（daemonPerformUpdate 成功完成 = 整个更新流程完成）
      reportUsageIfLoggedIn("remote_update_install_success", {});
      await loadSettings();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "更新失败";
      const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
      setUpdateLogs((prev) => [...prev, `[${time}] 错误: ${msg}`]);
      toast.error(msg);
      // 远程更新安装失败（确认为真实失败）
      reportUsageIfLoggedIn("remote_update_install_failure", { reason: msg });
    } finally {
      setUpdating(false);
    }
  };

  // 切换自动更新
  const handleToggleAuto = async (enabled: boolean) => {
    setTogglingAuto(true);
    try {
      await daemonSetAutoUpdate(deviceId, enabled);
      setSettings((s) => (s ? { ...s, autoUpdate: enabled } : s));
      toast.success(enabled ? "已开启自动更新" : "已关闭自动更新");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "设置失败");
    } finally {
      setTogglingAuto(false);
    }
  };

  if (loading) {
    return (
      <div className="flex h-40 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {error && <ErrorBlock message={error} />}

      {/* 当前版本 */}
      <div className="rounded-xl border border-border/40 bg-muted/20 backdrop-blur-md p-4">
        <div className="mb-3 flex items-center gap-2">
          <ArrowUpCircle className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-medium text-foreground">版本信息</h3>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-lg bg-background/40 backdrop-blur-sm p-3">
            <div className="text-xs text-muted-foreground">当前版本</div>
            <div className="mt-1 font-mono text-sm font-medium text-foreground">
              {settings?.currentVersion ?? "未知"}
            </div>
          </div>
          <div className="rounded-lg bg-background/40 backdrop-blur-sm p-3">
            <div className="text-xs text-muted-foreground">最新版本</div>
            <div className="mt-1 font-mono text-sm font-medium text-foreground">
              {checkResult?.latestVersion ?? "未检查"}
            </div>
          </div>
        </div>

        {/* 自动更新开关 */}
        <div className="mt-3 flex items-center justify-between rounded-lg bg-background/30 backdrop-blur-sm p-3">
          <div className="flex items-center gap-2">
            <DownloadCloud className="h-4 w-4 text-muted-foreground" />
            <div>
              <div className="text-sm font-medium text-foreground">自动更新</div>
              <div className="text-xs text-muted-foreground">检测到新版本时自动安装</div>
            </div>
          </div>
          <Switch
            checked={settings?.autoUpdate ?? false}
            onCheckedChange={handleToggleAuto}
            disabled={togglingAuto}
          />
        </div>
      </div>

      {/* 检查与执行更新 */}
      <div className="rounded-xl border border-border/40 bg-muted/20 backdrop-blur-md p-4">
        <h3 className="mb-3 text-sm font-medium text-foreground">更新操作</h3>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            onClick={() => void handleCheck(false)}
            disabled={checking || updating}
            className="gap-1.5"
          >
            {checking ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            检查更新
          </Button>
          <Button
            onClick={handleUpdate}
            disabled={updating || checking || !checkResult?.hasUpdate}
            className="gap-1.5"
          >
            {updating ? <Loader2 className="h-4 w-4 animate-spin" /> : <DownloadCloud className="h-4 w-4" />}
            {updating ? "更新中..." : "执行更新"}
          </Button>
        </div>

        {/* 检查结果 */}
        {checkResult && (
          <div className="mt-3 space-y-2">
            <div
              className={cn(
                "flex items-center gap-2 rounded-lg border p-3 text-sm backdrop-blur-sm",
                checkResult.hasUpdate
                  ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-400"
                  : "border-border bg-background/30 text-muted-foreground",
              )}
            >
              {checkResult.hasUpdate ? (
                <CheckCircle2 className="h-4 w-4 flex-shrink-0" />
              ) : (
                <CheckCircle2 className="h-4 w-4 flex-shrink-0 opacity-50" />
              )}
              {checkResult.hasUpdate
                ? `发现新版本 ${checkResult.latestVersion}，可点击「执行更新」安装`
                : "当前已是最新版本"}
            </div>
            {checkResult.releaseNotes && (
              <div className="rounded-lg border border-border/30 bg-background/30 backdrop-blur-sm p-3">
                <div className="mb-1 text-xs font-medium text-muted-foreground">更新日志</div>
                <pre className="whitespace-pre-wrap font-mono text-xs text-foreground">
                  {checkResult.releaseNotes}
                </pre>
              </div>
            )}
          </div>
        )}
      </div>

      {/* 更新过程日志面板（执行更新时显示） */}
      {(updating || updateLogs.length > 0) && (
        <div className="rounded-xl border border-border/40 bg-muted/20 backdrop-blur-md p-4">
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Terminal className="h-4 w-4 text-primary" />
              <h3 className="text-sm font-medium text-foreground">更新过程日志</h3>
              {updating && (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
              )}
            </div>
            <span className="text-xs font-medium text-muted-foreground tabular-nums">
              {updateProgress.toFixed(0)}%
            </span>
          </div>

          {/* 进度条 */}
          <div className="mb-3 w-full bg-muted rounded-full h-1.5 overflow-hidden">
            <div
              className="bg-primary h-full rounded-full transition-all duration-300"
              style={{ width: `${updateProgress}%` }}
            />
          </div>

          {/* 日志列表 */}
          <div className="max-h-[300px] overflow-auto visible-scrollbar rounded-lg bg-zinc-950/80 backdrop-blur-md p-3 dark:bg-black/50">
            {updateLogs.length > 0 ? (
              <pre className="whitespace-pre-wrap break-all font-mono text-xs leading-relaxed text-zinc-300">
                {updateLogs.join("\n")}
                <div ref={logsEndRef} />
              </pre>
            ) : (
              <p className="text-xs text-muted-foreground">等待更新开始...</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ===== 日志查看 Tab =====

/** 日志等级权重（数值越大越严重） */
const LOG_LEVEL_RANK: Record<string, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
};

/** 日志等级过滤选项 */
type LogLevelFilter = "all" | "debug" | "info" | "warn" | "error";

/** 解析单行日志的等级（tracing 格式：时间戳后跟 INFO/WARN/ERROR/DEBUG/TRACE） */
function parseLogLevel(line: string): keyof typeof LOG_LEVEL_RANK | null {
  const m = line.match(/\b(TRACE|DEBUG|INFO|WARN|ERROR)\b/);
  return m ? (m[1].toLowerCase() as keyof typeof LOG_LEVEL_RANK) : null;
}

/** 日志等级对应的行颜色（深色日志背景上的配色） */
function logLevelColor(level: keyof typeof LOG_LEVEL_RANK | null): string {
  switch (level) {
    case "error":
      return "text-red-400";
    case "warn":
      return "text-amber-400";
    case "debug":
      return "text-sky-400";
    case "trace":
      return "text-zinc-500";
    default:
      return "text-zinc-300"; // info 与无法解析等级的行
  }
}

export function LogsTab({ deviceId }: { deviceId: string }) {
  const [logs, setLogs] = useState<DaemonLogs | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lines, setLines] = useState(200);
  // 自动滚动开关：开启时日志更新后滚动到底部
  const [autoScroll, setAutoScroll] = useState(true);
  // 最低显示等级：显示该等级及更严重的日志行
  const [minLevel, setMinLevel] = useState<LogLevelFilter>("all");
  const logContainerRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await daemonGetLogs(deviceId, lines);
      setLogs(data);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "加载日志失败";
      setError(msg);
      toast.error(msg);
      // 获取服务日志失败（确认为真实失败）
      reportUsageIfLoggedIn("service_logs_failure", { reason: msg, lines });
    } finally {
      setLoading(false);
    }
  }, [deviceId, lines]);

  useEffect(() => {
    void load();
  }, [load]);

  // 按最低等级过滤日志行（无等级行视为 info 级别参与过滤）
  const visibleLines = useMemo(() => {
    if (!logs) return [];
    if (minLevel === "all") return logs.lines;
    const minRank = LOG_LEVEL_RANK[minLevel];
    return logs.lines.filter((line) => {
      const level = parseLogLevel(line) ?? "info";
      return LOG_LEVEL_RANK[level] >= minRank;
    });
  }, [logs, minLevel]);

  // 自动滚动：日志更新后滚到底部（仅在开关开启时）
  useEffect(() => {
    if (autoScroll && logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [visibleLines, autoScroll]);

  return (
    <div className="flex h-full min-h-0 flex-col rounded-xl border border-border/40 bg-muted/20 backdrop-blur-md p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Terminal className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-medium text-foreground">服务日志</h3>
          {logs && (
            <Badge variant="secondary" className="text-[10px]">
              {visibleLines.length} 行
              {minLevel !== "all" && logs.lines.length !== visibleLines.length && (
                <span className="text-muted-foreground"> / {logs.lines.length}</span>
              )}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          <label className="flex cursor-pointer select-none items-center gap-1.5 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={(e) => setAutoScroll(e.target.checked)}
              className="h-3.5 w-3.5 cursor-pointer accent-primary"
            />
            自动滚动
          </label>
          <Select
            options={[
              { value: "all", label: "全部等级" },
              { value: "debug", label: "调试及以上" },
              { value: "info", label: "信息及以上" },
              { value: "warn", label: "警告及以上" },
              { value: "error", label: "仅错误" },
            ]}
            value={minLevel}
            onChange={(value) => setMinLevel(value as LogLevelFilter)}
            size="sm"
            className="w-28"
          />
          <div className="flex items-center gap-1.5">
            <Label className="text-xs text-muted-foreground">行数</Label>
            <Input
              type="number"
              value={lines}
              min={50}
              max={2000}
              onChange={(e) =>
                setLines(Math.min(2000, Math.max(50, Number(e.target.value) || 200)))
              }
              className="h-8 w-20"
              disabled={loading}
            />
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={load}
            disabled={loading}
            className="gap-1.5"
          >
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            刷新
          </Button>
        </div>
      </div>

      {error ? (
        <ErrorBlock message={error} />
      ) : loading && !logs ? (
        <div className="flex h-40 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : visibleLines.length > 0 ? (
        <div
          ref={logContainerRef}
          className="visible-scrollbar min-h-0 flex-1 overflow-y-auto rounded-lg bg-zinc-950/80 backdrop-blur-md p-3 dark:bg-black/50"
        >
          {visibleLines.map((line, i) => (
            <div
              key={i}
              className={cn(
                "whitespace-pre-wrap break-all font-mono text-xs leading-relaxed",
                logLevelColor(parseLogLevel(line)),
              )}
            >
              {line}
            </div>
          ))}
        </div>
      ) : (
        <div className="flex h-40 flex-col items-center justify-center text-center">
          <Terminal className="mb-2 h-8 w-8 text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">
            {logs && logs.lines.length > 0 ? "当前筛选等级下暂无日志" : "暂无日志"}
          </p>
        </div>
      )}
    </div>
  );
}
