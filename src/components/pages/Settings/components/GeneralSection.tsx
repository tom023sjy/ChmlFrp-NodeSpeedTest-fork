import { useState, useEffect } from "react";
import {
  Item,
  ItemContent,
  ItemTitle,
  ItemDescription,
  ItemActions,
} from "@/components/ui/item";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  getCloseAction,
  setCloseAction,
  getBetaTooltipEnabled,
  setBetaTooltipEnabled,
  type CloseAction,
} from "@/lib/settings-utils";
import {
  getStoredStatisticMode,
  notifyNodeTestPreferencesChanged,
  setStoredStatisticMode,
  type StatisticMode,
  type StatisticTarget,
} from "@/services/nodeTestPreferences";

// 关闭窗口默认行为选项
const closeActionOptions = [
  { value: "ask", label: "每次询问" },
  { value: "minimize", label: "最小化到托盘" },
  { value: "exit", label: "直接退出" },
];

const statisticOptions = [
  { value: "max", label: "最大值" },
  { value: "avg", label: "平均值" },
  { value: "min", label: "最小值" },
];

export function GeneralSection() {
  const [closeAction, setCloseActionState] = useState<CloseAction>(() =>
    getCloseAction(),
  );
  const [betaTooltip, setBetaTooltip] = useState(() =>
    getBetaTooltipEnabled(),
  );
  const [latencyStatistic, setLatencyStatistic] = useState<StatisticMode>(() =>
    getStoredStatisticMode(localStorage, "latency"),
  );
  const [speedStatistic, setSpeedStatistic] = useState<StatisticMode>(() =>
    getStoredStatisticMode(localStorage, "speed"),
  );

  // 监听关闭行为变更（关闭弹窗记忆选择时会同步更新这里）
  useEffect(() => {
    const handler = () => setCloseActionState(getCloseAction());
    window.addEventListener("closeActionChanged", handler);
    return () => window.removeEventListener("closeActionChanged", handler);
  }, []);

  useEffect(() => {
    const handler = () => setBetaTooltip(getBetaTooltipEnabled());
    window.addEventListener("betaTooltipChanged", handler);
    return () => window.removeEventListener("betaTooltipChanged", handler);
  }, []);

  const handleChange = (value: string | number) => {
    const action = String(value) as CloseAction;
    setCloseAction(action);
    setCloseActionState(action);
  };

  const handleBetaToggle = (checked: boolean) => {
    setBetaTooltipEnabled(checked);
    setBetaTooltip(checked);
  };

  const handleStatisticChange = (
    target: StatisticTarget,
    value: string | number,
  ) => {
    const mode = String(value) as StatisticMode;
    setStoredStatisticMode(localStorage, target, mode);
    if (target === "latency") setLatencyStatistic(mode);
    else setSpeedStatistic(mode);
    notifyNodeTestPreferencesChanged();
  };

  return (
    <div className="rounded-lg bg-card overflow-hidden">
        <Item variant="outline" className="border-0">
          <ItemContent>
            <ItemTitle>关闭窗口行为</ItemTitle>
            <ItemDescription className="text-xs">
              点击窗口关闭按钮时的默认操作，可在关闭弹窗中勾选「记住」快速设置
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <Select
              options={closeActionOptions}
              value={closeAction}
              onChange={handleChange}
              size="sm"
              className="w-32"
            />
          </ItemActions>
        </Item>
        <Item variant="outline" className="border-0 border-t">
          <ItemContent>
            <ItemTitle>Beta 功能提示</ItemTitle>
            <ItemDescription className="text-xs">
              鼠标悬浮 Beta 标签时显示测试功能免责声明提示窗
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <Switch checked={betaTooltip} onCheckedChange={handleBetaToggle} />
          </ItemActions>
        </Item>
        <Item variant="outline" className="border-0 border-t">
          <ItemContent>
            <ItemTitle>节点延迟显示</ItemTitle>
            <ItemDescription className="text-xs">
              节点测试表格显示多次延迟探测的统计值
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <Select
              options={statisticOptions}
              value={latencyStatistic}
              onChange={(value) => handleStatisticChange("latency", value)}
              size="sm"
              className="w-24"
            />
          </ItemActions>
        </Item>
        <Item variant="outline" className="border-0 border-t">
          <ItemContent>
            <ItemTitle>节点带宽显示</ItemTitle>
            <ItemDescription className="text-xs">
              节点测试表格显示测速采样的统计值
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <Select
              options={statisticOptions}
              value={speedStatistic}
              onChange={(value) => handleStatisticChange("speed", value)}
              size="sm"
              className="w-24"
            />
          </ItemActions>
        </Item>
    </div>
  );
}
