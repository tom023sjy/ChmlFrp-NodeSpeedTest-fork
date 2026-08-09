import { useState } from "react";
import {
  ArrowLeft,
  Activity,
  Power,
  ArrowUpCircle,
  Terminal,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { DeviceInfo } from "@/services/deviceApi";
import { ServiceTab, UpdateTab, LogsTab } from "./DaemonManagePanel";

interface DeviceConsoleProps {
  device: DeviceInfo;
  onBack: () => void;
}

type ManageTab = "service" | "update" | "logs";

export function DeviceConsole({ device, onBack }: DeviceConsoleProps) {
  const isDaemon = device.deviceType === "daemon";
  const [activeTab, setActiveTab] = useState<ManageTab>("service");

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
      <div className="flex-1 overflow-auto px-6 py-4">
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
