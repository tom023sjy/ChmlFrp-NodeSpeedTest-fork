import { useRef, useState } from "react";
import {
  ArrowLeft,
  Activity,
  Power,
  ArrowUpCircle,
  Terminal,
  KeyRound,
} from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { useConfirm } from "@/components/ui/confirm-dialog";
import type { DeviceInfo } from "@/services/deviceApi";
import {
  generateSessionId,
  buildLoginUrl,
  startLoginPolling,
} from "@/services/backendApi";
import { daemonUpdateProxyToken } from "@/services/daemonManage";
import { ServiceTab, UpdateTab, LogsTab } from "./DaemonManagePanel";

interface DeviceConsoleProps {
  device: DeviceInfo;
  onBack: () => void;
}

type ManageTab = "service" | "update" | "logs";

export function DeviceConsole({ device, onBack }: DeviceConsoleProps) {
  const isDaemon = device.deviceType === "daemon";
  const [activeTab, setActiveTab] = useState<ManageTab>("service");

  // ===== 重新授权（更新 daemon 令牌）状态 =====
  const confirm = useConfirm();
  const [reauthState, setReauthState] = useState<"idle" | "polling">("idle");
  const abortRef = useRef<AbortController | null>(null);

  const cancelReauth = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setReauthState("idle");
  };

  /**
   * 远程重新授权流程：
   * 1. 打开浏览器完成 qzhua OAuth 授权
   * 2. 轮询拿到新的 proxyToken
   * 3. 通过 relay RPC 把新令牌发给 daemon（daemon 校验后写入配置并自动重连）
   */
  const startReauth = async () => {
    const ok = await confirm({
      title: "重新授权",
      description: (
        <div className="space-y-2">
          <p>将为该 daemon 重新获取授权令牌（用于服务端到客户端测速等功能）。</p>
          <p>点击确认后将在浏览器中打开授权页面，完成授权后新令牌会自动发送到服务器。</p>
          <p className="text-muted-foreground">令牌更新后服务器会短暂离线几秒后自动重连。</p>
        </div>
      ),
      variant: "info",
      icon: KeyRound,
      confirmText: "前往授权",
    });
    if (!ok) return;

    setReauthState("polling");
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      // 1. 浏览器授权 + 轮询结果
      const sessionId = generateSessionId();
      await openUrl(buildLoginUrl(sessionId));
      toast.info("已在浏览器中打开授权页面，请完成授权");

      const result = await startLoginPolling(sessionId, {
        intervalMs: 2000,
        timeoutMs: 5 * 60 * 1000,
        signal: controller.signal,
      });

      // 2. 把新令牌发给 daemon
      await daemonUpdateProxyToken(device.deviceId, result.proxyToken);
      toast.success("授权成功，daemon 令牌已更新，正在重连（约 3-5 秒）");
    } catch (err) {
      if (controller.signal.aborted) {
        toast.info("已取消授权");
      } else {
        toast.error(err instanceof Error ? err.message : "授权失败");
      }
    } finally {
      abortRef.current = null;
      setReauthState("idle");
    }
  };

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
              {device.isOnline ? (
                <Badge variant="outline" className="gap-1 border-emerald-500/30 text-emerald-600 dark:text-emerald-400">
                  <span className="inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
                  在线
                </Badge>
              ) : (
                <Badge variant="outline" className="text-muted-foreground">
                  离线
                </Badge>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              {device.osInfo || "未知"} · {device.hostname || "未知"}
            </p>
          </div>
        </div>

        {/* 重新授权：更新 daemon 的 proxy_token（仅 daemon 设备显示） */}
        {isDaemon && (
          <div className="ml-auto flex items-center gap-2">
            {reauthState === "polling" ? (
              <>
                <span className="text-xs text-muted-foreground">
                  等待浏览器授权完成…
                </span>
                <Button variant="outline" size="sm" onClick={cancelReauth}>
                  取消授权
                </Button>
              </>
            ) : (
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={startReauth}
                disabled={!device.isOnline}
                title={
                  device.isOnline
                    ? "重新获取授权令牌并更新到服务器"
                    : "设备离线，无法远程更新令牌（需在服务器上手动修改配置）"
                }
              >
                <KeyRound className="h-4 w-4" />
                重新授权
              </Button>
            )}
          </div>
        )}
      </div>

      {/* Tab 切换 */}
      {isDaemon && (
        <div className="flex gap-1 border-b border-border/40 px-6 py-2">
          <button
            className={cn(
              "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors",
              activeTab === "service"
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground hover:text-foreground hover:bg-muted/50",
            )}
            onClick={() => setActiveTab("service")}
          >
            <Power className="h-4 w-4" />
            服务控制
          </button>
          <button
            className={cn(
              "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors",
              activeTab === "update"
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground hover:text-foreground hover:bg-muted/50",
            )}
            onClick={() => setActiveTab("update")}
          >
            <ArrowUpCircle className="h-4 w-4" />
            更新管理
          </button>
          <button
            className={cn(
              "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors",
              activeTab === "logs"
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground hover:text-foreground hover:bg-muted/50",
            )}
            onClick={() => setActiveTab("logs")}
          >
            <Terminal className="h-4 w-4" />
            日志查看
          </button>
        </div>
      )}

      {/* 内容区 */}
      <div className="visible-scrollbar min-h-0 flex-1 overflow-y-auto px-6 py-4">
        {isDaemon ? (
          <>
            {activeTab === "service" && <ServiceTab deviceId={device.deviceId} />}
            {activeTab === "update" && <UpdateTab deviceId={device.deviceId} />}
            {activeTab === "logs" && <LogsTab deviceId={device.deviceId} />}
          </>
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            该设备类型暂不支持远程管理
          </div>
        )}
      </div>
    </div>
  );
}
