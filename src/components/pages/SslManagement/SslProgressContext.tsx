// SSL 证书申请进度全局上下文
// 把申请状态和浮动卡片提升到应用根级别，避免切换页面时组件卸载导致最小化窗口消失
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Loader2,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  X,
  Minus,
  Maximize2,
  Terminal,
  GripVertical,
} from "lucide-react";
import { toast } from "sonner";
import {
  sslService,
  type SslRequestParams,
  type SslRequestProgress,
  type SslRequestLog,
} from "@/services/sslService";
import type { StoredUser } from "@/services/api";
import { reportUsage } from "@/services/backendApi";

/** 已登录时上报事件，失败静默处理 */
function reportUsageIfLoggedIn(user: StoredUser | null, eventType: string, eventData?: Record<string, unknown>): void {
  if (!user?.accessToken) return;
  reportUsage({ eventType, eventData }).catch(() => {});
}

/** 申请阶段对应的中文标签 */
const STAGE_LABEL: Record<string, string> = {
  requesting: "申请中",
  adding_txt: "添加 TXT 记录",
  waiting_dns: "等待 DNS 传播",
  verifying: "触发验证",
  polling: "轮询状态",
  done: "完成",
  error: "失败",
};

/** 根据状态返回对应图标 */
function StageIcon({ stage, isFinal }: { stage: string; isFinal: boolean }) {
  const isError = stage === "error";
  const isSuccess = isFinal && !isError && stage === "done";
  if (!isFinal) return <Loader2 className="w-4 h-4 animate-spin text-primary" />;
  if (isError) return <XCircle className="w-4 h-4 text-destructive" />;
  if (isSuccess) return <CheckCircle2 className="w-4 h-4 text-emerald-500" />;
  return <AlertTriangle className="w-4 h-4 text-amber-500" />;
}

/** 全屏日志界面（模态，可最小化） */
function FullScreenProgress({
  logs,
  stage,
  isFinal,
  finalStatus,
  onMinimize,
  onClose,
}: {
  logs: string[];
  stage: string;
  isFinal: boolean;
  finalStatus: string | null;
  onMinimize: () => void;
  onClose: () => void;
}) {
  const logEndRef = useRef<HTMLDivElement>(null);
  const isError = stage === "error";
  const isSuccess = isFinal && !isError && stage === "done";

  // 日志自动滚动到底部
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [logs]);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="w-full max-w-3xl h-[80vh] max-h-[720px] rounded-xl border border-border/60 bg-card shadow-2xl flex flex-col overflow-hidden">
        {/* 头部 */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-border/40 bg-muted/20">
          <div className="flex items-center gap-2.5">
            <StageIcon stage={stage} isFinal={isFinal} />
            <div className="flex items-center gap-2">
              <Terminal className="w-4 h-4 text-muted-foreground" />
              <span className="text-sm font-semibold text-foreground">
                证书申请{isFinal ? (isError ? "失败" : isSuccess ? "成功" : "完成") : "进行中"}
              </span>
              {!isFinal && (
                <span className="text-[11px] px-2 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/20">
                  {STAGE_LABEL[stage] ?? stage}
                </span>
              )}
              {isFinal && finalStatus && (
                <span
                  className={cn(
                    "text-[11px] px-2 py-0.5 rounded-full border",
                    isSuccess
                      ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30"
                      : isError
                        ? "bg-destructive/10 text-destructive border-destructive/30"
                        : "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30"
                  )}
                >
                  最终状态：{finalStatus}
                </span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={onMinimize}
              className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
              title="最小化"
            >
              <Minus className="w-4 h-4" />
            </button>
            <button
              onClick={onClose}
              disabled={!isFinal}
              className={cn(
                "p-1.5 rounded-md transition-colors",
                isFinal
                  ? "text-muted-foreground hover:text-foreground hover:bg-muted/60"
                  : "text-muted-foreground/40 cursor-not-allowed"
              )}
              title={isFinal ? "关闭" : "申请完成后可关闭"}
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* 日志区 */}
        <div className="flex-1 min-h-0 overflow-y-auto visible-scrollbar p-4 bg-muted/10">
          <div className="space-y-1.5">
            {logs.length === 0 ? (
              <p className="text-xs text-muted-foreground px-1 py-2">等待日志输出...</p>
            ) : (
              logs.map((log, i) => (
                <div
                  key={i}
                  className="text-xs font-mono text-foreground/80 leading-relaxed flex gap-2"
                >
                  <span className="text-muted-foreground/60 select-none flex-shrink-0">
                    [{String(i + 1).padStart(2, "0")}]
                  </span>
                  <span className="break-all">{log}</span>
                </div>
              ))
            )}
            <div ref={logEndRef} />
          </div>
        </div>

        {/* 底部操作栏 */}
        <div className="flex items-center justify-between px-5 py-3 border-t border-border/40 bg-muted/20">
          <p className="text-xs text-muted-foreground">
            {isFinal
              ? isSuccess
                ? "证书已成功签发，可在 SSL 证书页面查看"
                : isError
                  ? "申请失败，请检查日志了解详细原因"
                  : "申请已结束，最终状态见上方"
              : "申请进行中，请勿关闭应用..."}
          </p>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={onMinimize}>
              <Minus className="w-3.5 h-3.5 mr-1.5" />
              最小化
            </Button>
            <Button size="sm" onClick={onClose} disabled={!isFinal}>
              <X className="w-3.5 h-3.5 mr-1.5" />
              关闭
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** 最小化浮动卡片（可拖动，双击/点击展开按钮恢复全屏） */
function ProgressCard({
  logs,
  stage,
  isFinal,
  onRestore,
  onClose,
}: {
  logs: string[];
  stage: string;
  isFinal: boolean;
  onRestore: () => void;
  onClose: () => void;
}) {
  const isError = stage === "error";
  const isSuccess = isFinal && !isError && stage === "done";
  // 最小化时只展示最后 4 条日志
  const recentLogs = logs.slice(-4);

  // ===== 拖动逻辑（参考 BatchTestFloatingWidget 实现）=====
  const [position, setPosition] = useState<{ left: number; top: number }>(() => ({
    left: typeof window !== "undefined" ? window.innerWidth - 340 : 0,
    top: typeof window !== "undefined" ? window.innerHeight - 260 : 0,
  }));
  const [isDragging, setIsDragging] = useState(false);
  const dragOffsetRef = useRef({ x: 0, y: 0 });

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      // 点击按钮（展开/关闭）时不触发拖动
      if ((e.target as HTMLElement).closest("button")) return;
      e.preventDefault();
      setIsDragging(true);
      const rect = e.currentTarget.getBoundingClientRect();
      dragOffsetRef.current = {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      };
    },
    [],
  );

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!isDragging) return;
      const newLeft = e.clientX - dragOffsetRef.current.x;
      const newTop = e.clientY - dragOffsetRef.current.y;
      // 卡片宽度 320px，限制不超出可视区域
      setPosition({
        left: Math.max(0, Math.min(window.innerWidth - 320, newLeft)),
        top: Math.max(0, Math.min(window.innerHeight - 100, newTop)),
      });
    },
    [isDragging],
  );

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
  }, []);

  useEffect(() => {
    if (isDragging) {
      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", handleMouseUp);
      return () => {
        window.removeEventListener("mousemove", handleMouseMove);
        window.removeEventListener("mouseup", handleMouseUp);
      };
    }
  }, [isDragging, handleMouseMove, handleMouseUp]);

  // 双击头部恢复全屏
  const handleDoubleClick = useCallback(() => {
    onRestore();
  }, [onRestore]);

  // 最后一行日志（收起状态下显示当前进度）
  const lastLog = logs.length > 0 ? logs[logs.length - 1] : "等待日志...";

  return (
    <div
      className="group fixed z-[60] w-80 rounded-xl border border-border/60 bg-card/95 backdrop-blur-md shadow-lg overflow-hidden cursor-move select-none transition-all duration-300 ease-out hover:shadow-2xl hover:border-primary/40"
      style={{ left: position.left, top: position.top }}
      onMouseDown={handleMouseDown}
    >
      {/* 头部（可拖动 + 双击恢复全屏） */}
      <div
        onDoubleClick={handleDoubleClick}
        className="flex items-center justify-between px-3 py-2.5 hover:bg-muted/40 transition-colors"
        title="拖动移动位置，双击恢复全屏日志"
      >
        <div className="flex items-center gap-2 min-w-0">
          <GripVertical className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
          <StageIcon stage={stage} isFinal={isFinal} />
          <span className="text-xs font-medium text-foreground truncate">
            证书申请{isFinal ? (isError ? "失败" : isSuccess ? "成功" : "完成") : "进行中"}
          </span>
          {!isFinal && (
            <span className="text-[10px] text-muted-foreground flex-shrink-0">
              · {STAGE_LABEL[stage] ?? stage}
            </span>
          )}
        </div>
        <button
          onClick={onRestore}
          className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors flex-shrink-0"
          title="展开日志"
        >
          <Maximize2 className="w-3.5 h-3.5" />
        </button>
      </div>
      {/* 收起状态：显示最后一行日志（当前进度），悬浮时隐藏 */}
      <div className="px-3 pb-2 group-hover:hidden">
        <p className="text-[11px] font-mono text-foreground/60 leading-relaxed truncate" title={lastLog}>
          {lastLog}
        </p>
      </div>
      {/* 悬浮时展开的详细信息（日志 + 底部操作） */}
      <div className="hidden group-hover:grid grid-rows-[1fr] opacity-100 transition-all duration-300 ease-out">
        <div className="overflow-hidden">
          {/* 日志区（截断显示） */}
          <div className="max-h-32 overflow-y-auto visible-scrollbar px-2.5 pt-1 pb-2 space-y-1 border-t border-border/40">
            {recentLogs.length === 0 ? (
              <p className="text-xs text-muted-foreground px-1 pt-1.5">等待日志...</p>
            ) : (
              recentLogs.map((log, i) => (
                <div key={i} className="text-[11px] font-mono text-foreground/75 leading-relaxed break-all">
                  {log}
                </div>
              ))
            )}
            {logs.length > recentLogs.length && (
              <p className="text-[10px] text-muted-foreground/60 italic px-1 pt-0.5">
                ...共 {logs.length} 条日志，点击上方展开查看全部
              </p>
            )}
          </div>
          {/* 底部操作 */}
          <div className="flex items-center justify-end gap-1 px-2.5 py-1.5 border-t border-border/40 bg-muted/20">
            <button
              onClick={onRestore}
              className="text-[11px] px-2 py-1 rounded text-primary hover:bg-primary/10 transition-colors"
            >
              展开日志
            </button>
            {isFinal && (
              <button
                onClick={onClose}
                className="text-[11px] px-2 py-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
              >
                关闭
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** 进度状态 */
interface ProgressState {
  logs: string[];
  stage: string;
  isFinal: boolean;
  finalStatus: string | null;
}

/** Context 提供的方法 */
interface SslProgressContextValue {
  /** 启动一次后台申请（自动打开全屏日志界面） */
  startRequest: (params: SslRequestParams, user: StoredUser | null) => Promise<void>;
  /** 注册申请完成后的回调（用于刷新 SSL 证书列表），传 null 取消注册 */
  registerOnComplete: (cb: (() => void) | null) => void;
  /** 注册申请日志保存成功后的回调（用于刷新日志列表），传 null 取消注册 */
  registerOnLogSaved: (cb: (() => void) | null) => void;
}

const SslProgressContext = createContext<SslProgressContextValue | null>(null);

/** 当前申请任务的元信息（用于完成时持久化日志） */
interface RequestMeta {
  taskId: string;
  params: SslRequestParams;
  username: string;
  createdAt: string;
}

/** SSL 申请进度全局 Provider（托管状态 + 渲染全屏/最小化卡片） */
export function SslProgressProvider({ children }: { children: ReactNode }) {
  const [progress, setProgress] = useState<ProgressState | null>(null);
  // 是否最小化为右下角小卡片（false = 全屏展示）
  const [minimized, setMinimized] = useState(false);
  // 申请完成后的回调（由 SslManagement 注册 load 函数）
  const onCompleteRef = useRef<(() => void) | null>(null);
  // 日志保存成功后的回调（由 SslManagement 注册 loadLogs 函数）
  const onLogSavedRef = useRef<(() => void) | null>(null);
  const unlistenRef = useRef<(() => void) | null>(null);
  // 当前申请任务元信息（startRequest 时记录，isFinal 时用于持久化）
  const metaRef = useRef<RequestMeta | null>(null);

  // 组件卸载时取消事件监听
  useEffect(() => {
    return () => {
      unlistenRef.current?.();
    };
  }, []);

  const startRequest = useCallback(
    async (params: SslRequestParams, user: StoredUser | null) => {
      if (!user?.username) return;
      // 清理旧的监听
      unlistenRef.current?.();
      // 默认全屏展示
      setMinimized(false);
      setProgress({ logs: [], stage: "requesting", isFinal: false, finalStatus: null });
      // 预先记录元信息（taskId 用前端时间戳生成，与后端 task_id 解耦，仅用于日志去重）
      metaRef.current = {
        taskId: `ssl-${Date.now()}`,
        params,
        username: user.username,
        createdAt: new Date().toISOString(),
      };
      // 上报申请开始事件（仅准确事件：此处确认为真实开始）
      reportUsageIfLoggedIn(user, "ssl_request_start", {
        provider: params.provider,
        domain_count: params.domains.length,
        challenge_type: params.challengeType,
      });
      try {
        const unlisten = await sslService.autoRequestAsync(
          user.username,
          params,
          (p: SslRequestProgress) => {
            setProgress((prev) => {
              const next: ProgressState = {
                logs: [...(prev?.logs ?? []), p.message],
                stage: p.stage,
                isFinal: p.isFinal,
                finalStatus: p.finalStatus,
              };
              // 最终消息时持久化日志
              if (p.isFinal) {
                const meta = metaRef.current;
                if (meta) {
                  const log: SslRequestLog = {
                    id: meta.taskId,
                    domains: meta.params.domains.join(", "),
                    provider: meta.params.provider,
                    finalStatus: p.finalStatus ?? (p.stage === "error" ? "failed" : "unknown"),
                    logs: next.logs,
                    createdAt: meta.createdAt,
                    finishedAt: new Date().toISOString(),
                    ownerUsername: meta.username,
                  };
                  // 异步保存，不阻塞 UI
                  sslService
                    .saveLog(log)
                    .then(() => onLogSavedRef.current?.())
                    .catch((err) => console.error("保存 SSL 申请日志失败:", err));
                }
              }
              return next;
            });
            if (p.isFinal) {
              // 基于后端最终状态可靠上报申请结果
              const meta = metaRef.current;
              const baseData = {
                provider: meta?.params.provider,
                domain_count: meta?.params.domains.length ?? 0,
                final_status: p.finalStatus ?? null,
                final_stage: p.stage,
              };
              if (p.stage === "done" && p.finalStatus === "issued") {
                toast.success("证书申请成功！");
                reportUsageIfLoggedIn(user, "ssl_request_success", baseData);
              } else if (p.stage === "error") {
                toast.error(`证书申请失败：${p.message}`);
                reportUsageIfLoggedIn(user, "ssl_request_failure", { ...baseData, reason: p.message });
              } else if (p.finalStatus && p.finalStatus !== "issued") {
                toast.warning(`证书状态：${p.finalStatus}`);
                // 非成功签发也视为失败结果上报
                reportUsageIfLoggedIn(user, "ssl_request_failure", { ...baseData, reason: `final_status=${p.finalStatus}` });
              }
              // 通知 SslManagement 刷新证书列表
              onCompleteRef.current?.();
            }
          },
        );
        unlistenRef.current = unlisten;
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        toast.error(e instanceof Error ? e.message : "启动申请失败");
        // 启动阶段失败（无法进入进度回调）也视为申请失败
        reportUsageIfLoggedIn(user, "ssl_request_failure", {
          provider: params.provider,
          domain_count: params.domains.length,
          final_status: "failed",
          final_stage: "startup_error",
          reason,
        });
        setProgress(null);
        metaRef.current = null;
      }
    },
    [],
  );

  const registerOnComplete = useCallback((cb: (() => void) | null) => {
    onCompleteRef.current = cb;
  }, []);

  const registerOnLogSaved = useCallback((cb: (() => void) | null) => {
    onLogSavedRef.current = cb;
  }, []);

  const closeProgress = useCallback(() => {
    unlistenRef.current?.();
    unlistenRef.current = null;
    setProgress(null);
  }, []);

  return (
    <SslProgressContext.Provider value={{ startRequest, registerOnComplete, registerOnLogSaved }}>
      {children}
      {/* 全屏日志界面 */}
      {progress && !minimized && (
        <FullScreenProgress
          logs={progress.logs}
          stage={progress.stage}
          isFinal={progress.isFinal}
          finalStatus={progress.finalStatus}
          onMinimize={() => setMinimized(true)}
          onClose={closeProgress}
        />
      )}
      {/* 最小化浮动卡片 */}
      {progress && minimized && (
        <ProgressCard
          logs={progress.logs}
          stage={progress.stage}
          isFinal={progress.isFinal}
          onRestore={() => setMinimized(false)}
          onClose={closeProgress}
        />
      )}
    </SslProgressContext.Provider>
  );
}

/** 供 SslManagement 使用的 hook */
export function useSslProgress(): SslProgressContextValue {
  const ctx = useContext(SslProgressContext);
  if (!ctx) {
    throw new Error("useSslProgress 必须在 SslProgressProvider 内部使用");
  }
  return ctx;
}
