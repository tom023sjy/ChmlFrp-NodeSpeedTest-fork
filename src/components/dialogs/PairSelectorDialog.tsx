/**
 * 设备对选择弹窗
 *
 * 用于在节点测试页面切换查看不同设备对（发送端→接收端）的测试结果。
 * 用户选择发送端和接收端后，表格切换为该方向的数据。
 * 如果需要查看反方向数据，点击"切换方向"按钮即可一键交换发送端和接收端。
 */
import { useState, useEffect, useCallback } from "react";
import { Monitor, Server, ArrowRight, ArrowLeftRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { listDevices, type DeviceInfo } from "@/services/deviceApi";

/** 本机设备选项 */
const LOCAL_DEVICE = {
  deviceId: "local",
  deviceName: "本机",
  deviceType: "desktop" as const,
  osInfo: "",
};

export interface DevicePair {
  senderId: string;
  senderName: string;
  receiverId: string;
  receiverName: string;
}

interface PairSelectorDialogProps {
  isOpen: boolean;
  onClose: () => void;
  /** 当前选中的设备对 */
  currentPair: DevicePair;
  /** 确认选择回调 */
  onSelect: (pair: DevicePair) => void;
  /** 已有测试结果的设备对 key 列表（用于提示哪些对有数据） */
  availablePairKeys?: string[];
}

export function PairSelectorDialog({
  isOpen,
  onClose,
  currentPair,
  onSelect,
  availablePairKeys = [],
}: PairSelectorDialogProps) {
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [senderId, setSenderId] = useState(currentPair.senderId);
  const [receiverId, setReceiverId] = useState(currentPair.receiverId);

  useEffect(() => {
    if (isOpen) {
      setSenderId(currentPair.senderId);
      setReceiverId(currentPair.receiverId);
      void loadData();
    }
  }, [isOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const deviceList = await listDevices();
      // 过滤在线设备，并排除 API 返回的本机设备（isCurrent:true），避免与"本机"选项重复
      setDevices(deviceList.filter((d) => d.isOnline && !d.isCurrent));
    } catch {
      // 加载失败时只显示本机
    } finally {
      setLoading(false);
    }
  }, []);

  // 所有可选设备（本机 + 在线设备）
  const allDevices = [LOCAL_DEVICE, ...devices];

  const getDeviceName = (id: string) => {
    if (id === "local") return "本机";
    const d = devices.find((d) => d.deviceId === id);
    return d?.deviceName ?? id;
  };

  const handleConfirm = () => {
    onSelect({
      senderId,
      senderName: getDeviceName(senderId),
      receiverId,
      receiverName: getDeviceName(receiverId),
    });
    onClose();
  };

  const handleSwap = () => {
    setSenderId(receiverId);
    setReceiverId(senderId);
  };

  const pairKey = `${senderId}__${receiverId}`;
  const hasData = availablePairKeys.includes(pairKey);

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ArrowLeftRight className="h-5 w-5 text-primary" />
            选择测试结果
          </DialogTitle>
          <DialogDescription>
            选择发送端和接收端，查看对应方向的测试数据
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* 发送端选择 */}
          <div className="space-y-2">
            <label className="text-sm font-medium">发送端（创建隧道）</label>
            <DeviceSelector
              devices={allDevices}
              selectedId={senderId}
              onSelect={setSenderId}
              loading={loading}
            />
          </div>

          {/* 切换方向按钮 */}
          <div className="flex justify-center">
            <Button
              size="sm"
              variant="ghost"
              onClick={handleSwap}
              className="h-7 px-2"
              title="交换发送端和接收端"
            >
              <ArrowRight className="h-4 w-4" />
              <span className="ml-1 text-xs">切换方向</span>
            </Button>
          </div>

          {/* 接收端选择 */}
          <div className="space-y-2">
            <label className="text-sm font-medium">接收端（执行测速）</label>
            <DeviceSelector
              devices={allDevices}
              selectedId={receiverId}
              onSelect={setReceiverId}
              loading={loading}
            />
          </div>

          {/* 数据提示 */}
          <div className="text-xs text-muted-foreground text-center">
            {hasData
              ? `将显示 ${getDeviceName(senderId)} → ${getDeviceName(receiverId)} 的测试数据`
              : `${getDeviceName(senderId)} → ${getDeviceName(receiverId)} 暂无测试数据`}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button onClick={handleConfirm} disabled={senderId === receiverId ? false : false}>
            确认
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ===== 设备选择器子组件 =====

function DeviceSelector({
  devices,
  selectedId,
  onSelect,
  loading,
}: {
  devices: { deviceId: string; deviceName: string; deviceType: string; osInfo: string }[];
  selectedId: string;
  onSelect: (id: string) => void;
  loading: boolean;
}) {
  if (loading) {
    return (
      <div className="text-sm text-muted-foreground p-2">
        加载设备列表...
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-2 max-h-40 overflow-y-auto visible-scrollbar">
      {devices.map((d) => (
        <button
          key={d.deviceId}
          onClick={() => onSelect(d.deviceId)}
          className={cn(
            "flex items-center gap-2 rounded-lg border p-2.5 text-left transition-colors",
            selectedId === d.deviceId
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
          </div>
        </button>
      ))}
    </div>
  );
}
