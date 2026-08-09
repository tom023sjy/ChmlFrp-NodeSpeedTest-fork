import { useState, useEffect, useCallback } from "react";
import {
  MonitorSmartphone,
  RefreshCw,
  Loader2,
  Inbox,
  PlugZap,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { toast } from "sonner";
import type { StoredUser } from "@/services/api";
import { useEffectType, getCardClassName } from "@/lib/useEffectType";
import { getRelayClient } from "@/services/deviceRelay";
import {
  listDevices,
  renameDevice,
  unbindDevice,
  type DeviceInfo,
} from "@/services/deviceApi";
import { DeviceCard } from "./DeviceCard";
import { DeviceConsole } from "./DeviceConsole";

interface DeviceManagementProps {
  user?: StoredUser | null;
}

export function DeviceManagement({ user }: DeviceManagementProps) {
  const confirm = useConfirm();
  const effectType = useEffectType();
  const isLoggedIn = !!user?.accessToken;

  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [connected, setConnected] = useState(false);
  // 选中的设备（进入远程控制台）
  const [selectedDevice, setSelectedDevice] = useState<DeviceInfo | null>(null);

  // 重命名对话框状态
  const [renaming, setRenaming] = useState<DeviceInfo | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renamingLoading, setRenamingLoading] = useState(false);

  const load = useCallback(async () => {
    if (!isLoggedIn) {
      setDevices([]);
      return;
    }
    setLoading(true);
    try {
      setDevices(await listDevices());
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "加载设备列表失败");
    } finally {
      setLoading(false);
    }
  }, [isLoggedIn]);

  // 初始加载 + 登录状态变化时重新加载
  useEffect(() => {
    load();
  }, [load]);

  // 订阅 relay 连接状态与设备上下线事件，实时刷新列表
  useEffect(() => {
    const relay = getRelayClient();
    setConnected(relay.isConnected());
    const unlistenConn = relay.onConnectionChange((c) => setConnected(c));
    const unlistenOnline = relay.on("device_online", () => {
      void load();
    });
    const unlistenOffline = relay.on("device_offline", () => {
      void load();
    });
    return () => {
      unlistenConn();
      unlistenOnline();
      unlistenOffline();
    };
  }, [load]);

  // 打开重命名对话框
  const handleOpenRename = (device: DeviceInfo) => {
    setRenaming(device);
    setRenameValue(device.deviceName || "");
  };

  // 提交重命名
  const handleSubmitRename = async () => {
    if (!renaming) return;
    const name = renameValue.trim();
    if (!name) {
      toast.error("请输入设备名称");
      return;
    }
    if (name.length > 32) {
      toast.error("设备名称不能超过 32 个字符");
      return;
    }
    setRenamingLoading(true);
    try {
      await renameDevice(renaming.deviceId, name);
      toast.success("已重命名");
      setRenaming(null);
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "重命名失败");
    } finally {
      setRenamingLoading(false);
    }
  };

  // 解绑设备
  const handleUnbind = async (device: DeviceInfo) => {
    const ok = await confirm({
      title: "解绑设备",
      description: (
        <div className="space-y-1.5">
          <p>
            确认解绑设备「{device.deviceName || "未命名设备"}」？
          </p>
          <p className="text-xs text-muted-foreground">
            解绑后该设备将从列表中移除，需重新登录后才会再次出现。设备上的数据不会被删除。
          </p>
          {device.isCurrent && (
            <p className="text-xs font-medium text-destructive">
              注意：这是当前正在使用的设备，解绑后可能导致本机连接异常。
            </p>
          )}
        </div>
      ),
      confirmText: "确认解绑",
      variant: "destructive",
    });
    if (!ok) return;
    try {
      await unbindDevice(device.deviceId);
      toast.success("已解绑");
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "解绑失败");
    }
  };

  // 在线数量统计
  const onlineCount = devices.filter((d) => d.isOnline).length;

  // 选中设备时渲染远程控制台
  if (selectedDevice) {
    return (
      <DeviceConsole
        device={selectedDevice}
        onBack={() => setSelectedDevice(null)}
      />
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* 顶部标题栏 */}
      <div className="flex items-center justify-between border-b border-border/40 px-6 py-4">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/10">
            <MonitorSmartphone className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h1 className="text-base font-semibold text-foreground">设备管理</h1>
            <p className="text-xs text-muted-foreground">
              查看同账号下的所有设备，支持重命名与解绑
              {isLoggedIn && devices.length > 0 && (
                <>
                  <span className="mx-1.5 text-muted-foreground/40">·</span>
                  共 {devices.length} 台，{onlineCount} 台在线
                </>
              )}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {/* 中继连接状态指示 */}
          {isLoggedIn && (
            <div
              className={cn(
                "flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs",
                connected
                  ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-600 dark:text-emerald-400"
                  : "border-border bg-muted/30 text-muted-foreground",
              )}
              title={connected ? "中继已连接" : "中继未连接"}
            >
              <span
                className={cn(
                  "inline-flex h-1.5 w-1.5 rounded-full",
                  connected ? "bg-emerald-500" : "bg-muted-foreground/50",
                )}
              />
              {connected ? "已连接" : "未连接"}
            </div>
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={load}
            disabled={!isLoggedIn || loading}
            className="gap-1.5"
            title={!isLoggedIn ? "请先登录" : undefined}
          >
            {loading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            刷新
          </Button>
        </div>
      </div>

      {/* 内容区 */}
      <div className="flex-1 overflow-auto px-6 py-4">
        {/* 未登录提示 */}
        {!isLoggedIn && (
          <div className={cn("rounded-xl border border-dashed border-border/60 p-8 text-center", getCardClassName(effectType))}>
            <PlugZap className="mx-auto mb-3 h-10 w-10 text-muted-foreground/40" />
            <p className="text-sm font-medium text-foreground">请先登录</p>
            <p className="mt-1 text-xs text-muted-foreground">
              登录后可查看和管理同账号下的所有设备
            </p>
          </div>
        )}

        {/* 加载中 */}
        {isLoggedIn && loading && devices.length === 0 && (
          <div className="flex h-40 items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        )}

        {/* 空状态 */}
        {isLoggedIn && !loading && devices.length === 0 && (
          <div className={cn("rounded-xl border border-dashed border-border/60 p-8 text-center", getCardClassName(effectType))}>
            <Inbox className="mx-auto mb-3 h-10 w-10 text-muted-foreground/40" />
            <p className="text-sm font-medium text-foreground">暂无设备</p>
            <p className="mt-1 text-xs text-muted-foreground">
              其他设备登录同账号后将自动出现在此处
            </p>
          </div>
        )}

        {/* 设备卡片网格 */}
        {devices.length > 0 && (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {devices.map((device) => (
              <DeviceCard
                key={device.deviceId}
                device={device}
                effectType={effectType}
                isLoggedIn={isLoggedIn}
                onRename={handleOpenRename}
                onUnbind={handleUnbind}
                onManage={setSelectedDevice}
              />
            ))}
          </div>
        )}
      </div>

      {/* 重命名对话框 */}
      <Dialog
        open={renaming !== null}
        onOpenChange={(open) => {
          if (!open) {
            setRenaming(null);
            setRenameValue("");
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>重命名设备</DialogTitle>
            <DialogDescription>
              为设备设置一个易于识别的名称，长度不超过 32 个字符。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <Label htmlFor="device-name">设备名称</Label>
            <Input
              id="device-name"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              placeholder="例如：我的电脑、西安服务器"
              maxLength={32}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void handleSubmitRename();
                }
              }}
            />
            <p className="text-xs text-muted-foreground">
              {renameValue.length}/32
            </p>
          </div>
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={() => {
                setRenaming(null);
                setRenameValue("");
              }}
            >
              取消
            </Button>
            <Button
              onClick={handleSubmitRename}
              disabled={renamingLoading || !renameValue.trim()}
            >
              {renamingLoading && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
