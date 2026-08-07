import { useMemo } from "react";
import {
  Monitor,
  Server,
  Pencil,
  Unlink,
  Wifi,
  WifiOff,
  CircleDot,
  ArrowRight,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { getCardClassName } from "@/lib/useEffectType";
import type { EffectType } from "@/lib/settings-utils";
import type { DeviceInfo } from "@/services/deviceApi";

interface DeviceCardProps {
  device: DeviceInfo;
  effectType: EffectType;
  isLoggedIn: boolean;
  onRename: (device: DeviceInfo) => void;
  onUnbind: (device: DeviceInfo) => void;
  onManage: (device: DeviceInfo) => void;
}

/** 格式化最后活动时间，无法解析则返回原始字符串 */
function formatLastSeen(iso: string): string {
  if (!iso) return "未知";
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return iso;
  const now = Date.now();
  const diff = now - dt.getTime();
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  // 超过 7 天显示日期
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, "0");
  const d = String(dt.getDate()).padStart(2, "0");
  const hh = String(dt.getHours()).padStart(2, "0");
  const mm = String(dt.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${d} ${hh}:${mm}`;
}

export function DeviceCard({
  device,
  effectType,
  isLoggedIn,
  onRename,
  onUnbind,
  onManage,
}: DeviceCardProps) {
  const isDesktop = device.deviceType === "desktop";
  const TypeIcon = isDesktop ? Monitor : Server;
  const lastSeen = useMemo(() => formatLastSeen(device.lastSeenAt), [device.lastSeenAt]);

  // 未登录时禁用所有操作按钮
  const disabled = !isLoggedIn;
  const disabledTip = disabled ? "请先登录" : undefined;

  return (
    <div
      className={cn(
        "rounded-xl border border-border/40 p-4 transition-all duration-200 hover:border-primary/30 hover:shadow-sm",
        getCardClassName(effectType),
      )}
    >
      {/* 头部：图标 + 设备名 + 状态点 */}
      <div className="flex items-start gap-3">
        <div
          className={cn(
            "flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg",
            device.isOnline
              ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
              : "bg-muted text-muted-foreground",
          )}
        >
          <TypeIcon className="h-5 w-5" />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-sm font-semibold text-foreground">
              {device.deviceName || "未命名设备"}
            </h3>
            {device.isCurrent && (
              <Badge variant="secondary" className="flex-shrink-0 text-[10px]">
                本机
              </Badge>
            )}
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
            {device.isOnline ? (
              <>
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-75" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
                </span>
                <span className="text-emerald-600 dark:text-emerald-400">在线</span>
              </>
            ) : (
              <>
                <span className="inline-flex h-2 w-2 rounded-full bg-muted-foreground/50" />
                <span>离线</span>
              </>
            )}
            <span className="text-muted-foreground/40">·</span>
            <span>{isDesktop ? "桌面客户端" : "守护进程"}</span>
          </div>
        </div>

        {/* 互联状态徽章 */}
        <div className="flex-shrink-0">
          {device.interconnectEnabled ? (
            <Badge variant="outline" className="gap-1 border-emerald-500/30 text-emerald-600 dark:text-emerald-400">
              <Wifi className="h-3 w-3" />
              可远程
            </Badge>
          ) : (
            <Badge variant="outline" className="gap-1 text-muted-foreground">
              <WifiOff className="h-3 w-3" />
              未开启
            </Badge>
          )}
        </div>
      </div>

      {/* 详情区 */}
      <div className="mt-3 space-y-1.5 border-t border-border/30 pt-3 text-xs">
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">操作系统</span>
          <span className="font-medium text-foreground">{device.osInfo || "未知"}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">主机名</span>
          <span className="font-medium text-foreground">{device.hostname || "未知"}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">最后活动</span>
          <span className="flex items-center gap-1 font-medium text-foreground">
            <CircleDot className="h-3 w-3 text-muted-foreground/60" />
            {lastSeen}
          </span>
        </div>
      </div>

      {/* 操作按钮 */}
      <div className="mt-3 flex items-center gap-2 border-t border-border/30 pt-3">
        <Button
          variant="outline"
          size="sm"
          className="h-8 flex-1 gap-1.5"
          onClick={() => onRename(device)}
          disabled={disabled}
          title={disabledTip}
        >
          <Pencil className="h-3.5 w-3.5" />
          重命名
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-8 flex-1 gap-1.5 hover:border-destructive/40 hover:text-destructive"
          onClick={() => onUnbind(device)}
          disabled={disabled}
          title={disabledTip}
        >
          <Unlink className="h-3.5 w-3.5" />
          解绑
        </Button>
      </div>

      {/* 远程管理入口：设备在线且开启互联时可进入控制台 */}
      <div className="mt-2 border-t border-border/30 pt-2">
        <Button
          variant="default"
          size="sm"
          className="h-8 w-full gap-1.5"
          onClick={() => onManage(device)}
          disabled={disabled || !device.isOnline || !device.interconnectEnabled || device.isCurrent}
          title={
            !isLoggedIn
              ? "请先登录"
              : !device.isOnline
                ? "设备离线"
                : !device.interconnectEnabled
                  ? "设备未开启互联"
                  : device.isCurrent
                    ? "本机无需远程管理"
                    : "远程管理"
          }
        >
          <ArrowRight className="h-3.5 w-3.5" />
          远程管理
        </Button>
      </div>
    </div>
  );
}
