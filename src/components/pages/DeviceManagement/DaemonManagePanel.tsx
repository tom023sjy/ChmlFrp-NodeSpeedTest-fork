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
import { useState, useCallback, useEffect, useRef } from "react";
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

interface DaemonManagePanelProps {
  deviceId: string;
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

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const s = await daemonServiceControl(deviceId, "status");
      setStatus(s);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "获取状态失败";
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [deviceId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleAction = async (action: "start" | "stop" | "restart") => {
    setActionLoading(action);
    try {
      await daemonServiceControl(deviceId, action);
      toast.success(
        action === "start" ? "服务已启动" : action === "stop" ? "服务已停止" : "服务已重启",
      );
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "操作失败");
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
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Power className="h-4 w-4 text-primary" />
            <h3 className="text-sm font-medium text-foreground">服务状态</h3>
          </div>
          <Button variant="ghost" size="icon-sm" onClick={refresh} title="刷新">
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
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

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  // 日志自动滚动到底部
  useEffect(() => {
    if (logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [updateLogs]);

  // 检查更新
  const handleCheck = async () => {
    setChecking(true);
    try {
      const result = await daemonCheckUpdate(deviceId);
      setCheckResult(result);
      if (result.hasUpdate) {
        toast.success(`发现新版本：${result.latestVersion}`);
      } else {
        toast.info("当前已是最新版本");
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "检查更新失败");
    } finally {
      setChecking(false);
    }
  };

  // 执行更新（实时显示进度日志）
  const handleUpdate = async () => {
    setUpdating(true);
    setUpdateLogs([]);
    setUpdateProgress(0);
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
      toast.success("更新已完成");
      setCheckResult(null);
      await loadSettings();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "更新失败";
      const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
      setUpdateLogs((prev) => [...prev, `[${time}] 错误: ${msg}`]);
      toast.error(msg);
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
            onClick={handleCheck}
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

export function LogsTab({ deviceId }: { deviceId: string }) {
  const [logs, setLogs] = useState<DaemonLogs | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lines, setLines] = useState(200);

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
    } finally {
      setLoading(false);
    }
  }, [deviceId, lines]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-border/40 bg-muted/20 backdrop-blur-md p-4">
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Terminal className="h-4 w-4 text-primary" />
            <h3 className="text-sm font-medium text-foreground">服务日志</h3>
            {logs && (
              <Badge variant="secondary" className="text-[10px]">
                {logs.lines.length} 行
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-2">
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
        ) : logs && logs.lines.length > 0 ? (
          <div className="max-h-[480px] overflow-auto visible-scrollbar rounded-lg bg-zinc-950/80 backdrop-blur-md p-3 dark:bg-black/50">
            <pre className="whitespace-pre-wrap break-all font-mono text-xs leading-relaxed text-zinc-300">
              {logs.lines.join("\n")}
            </pre>
          </div>
        ) : (
          <div className="flex h-40 flex-col items-center justify-center text-center">
            <Terminal className="mb-2 h-8 w-8 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">暂无日志</p>
          </div>
        )}
      </div>
    </div>
  );
}
