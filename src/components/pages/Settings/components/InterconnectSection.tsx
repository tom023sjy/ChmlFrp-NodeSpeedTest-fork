import { useState, useEffect } from "react";
import {
  Item,
  ItemContent,
  ItemTitle,
  ItemDescription,
  ItemActions,
} from "@/components/ui/item";
import { Switch } from "@/components/ui/switch";

const STORAGE_KEY = "interconnect_enabled";

/** 读取互联开关状态，默认关闭 */
export function getInterconnectEnabled(): boolean {
  return localStorage.getItem(STORAGE_KEY) === "true";
}

/** 写入互联开关状态并派发事件，供 App.tsx 监听后重连 relay */
export function setInterconnectEnabled(enabled: boolean): void {
  localStorage.setItem(STORAGE_KEY, enabled.toString());
  window.dispatchEvent(new Event("interconnectChanged"));
}

export function InterconnectSection() {
  const [enabled, setEnabled] = useState<boolean>(() =>
    getInterconnectEnabled(),
  );

  useEffect(() => {
    const handler = () => setEnabled(getInterconnectEnabled());
    window.addEventListener("interconnectChanged", handler);
    return () => window.removeEventListener("interconnectChanged", handler);
  }, []);

  const handleToggle = (checked: boolean) => {
    setInterconnectEnabled(checked);
    setEnabled(checked);
  };

  return (
    <div className="overflow-hidden rounded-lg bg-card">
        <Item variant="outline" className="border-0">
          <ItemContent>
            <ItemTitle>允许远程管理</ItemTitle>
            <ItemDescription className="text-xs">
              开启后，同账号的其他设备可远程对本机执行延迟与带宽测试。关闭后本机不会被远程命令打扰。
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <Switch checked={enabled} onCheckedChange={handleToggle} />
          </ItemActions>
        </Item>
    </div>
  );
}
