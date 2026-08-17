import { useMemo } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Clock, Download, BarChart3 } from "lucide-react";
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { getNodeTestHistory, type TestHistoryPair, type TestHistoryRecord } from "@/services/testHistoryService";

interface NodeHistoryDialogProps {
  isOpen: boolean;
  onClose: () => void;
  nodeName: string;
  nodeId?: number;
  type: "latency" | "speed";
  /** 当前登录用户名，用于按账号隔离历史记录 */
  username?: string;
  pair?: TestHistoryPair;
}

export function NodeHistoryDialog({ isOpen, onClose, nodeName, type, username, pair }: NodeHistoryDialogProps) {
  const history = useMemo<TestHistoryRecord[]>(
    () => isOpen ? getNodeTestHistory(nodeName, username, pair) : [],
    [isOpen, nodeName, username, pair],
  );

  const formatSpeed = (speedMbps: number): string => {
    if (speedMbps >= 1000) {
      return `${(speedMbps / 1000).toFixed(2)} Gbps`;
    }
    return `${speedMbps.toFixed(2)} Mbps`;
  };

  const isLatency = type === "latency";
  const record = useMemo(() => history.find((item) => isLatency ? item.latency != null : item.downloadSpeed != null), [history, isLatency]);
  const latencySamples = record?.latencySamples;
  const speedSamples = record?.speedSamples;
  const chartData = isLatency
    ? latencySamples?.map((value, index) => ({ label: `第 ${index + 1} 次`, value })) ?? []
    : speedSamples?.map((sample) => ({ label: `${sample.second} 秒`, value: sample.mbps })) ?? [];
  const values = chartData.flatMap((item) => item.value == null ? [] : [item.value]);
  const minimum = values.length > 0 ? Math.min(...values) : null;
  const maximum = values.length > 0 ? Math.max(...values) : null;
  const average = values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  const hasHistory = record != null;
  const hasSamples = chartData.length > 0;
  const tickInterval = Math.max(0, Math.ceil(chartData.length / 8) - 1);
  const tooltipStyle = {
    border: "1px solid var(--color-border)",
    borderRadius: "0.625rem",
    background: "var(--color-popover)",
    color: "var(--color-popover-foreground)",
    boxShadow: "0 8px 24px rgba(0, 0, 0, 0.12)",
    fontSize: "0.75rem",
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BarChart3 className="w-5 h-5" />
            {isLatency ? "延迟详情" : "速度详情"}
          </DialogTitle>
          <DialogDescription>
            节点: {nodeName}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {!hasHistory ? (
            <div className="text-center text-muted-foreground py-8">
              暂无{isLatency ? "延迟" : "速度"}测试历史
            </div>
          ) : (
            <>
              <div className="p-3 bg-muted/50 rounded-lg">
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-2">
                  {isLatency ? <Clock className="w-3 h-3" /> : <Download className="w-3 h-3" />}
                  {isLatency ? "本次延迟统计" : "本次速度统计"}
                </div>
                <div className="space-y-1 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">最低:</span>
                    <span className="text-green-600">
                      {minimum == null ? "-" : isLatency ? `${minimum.toFixed(2)}ms` : formatSpeed(minimum)}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">最高:</span>
                    <span className="text-red-600">
                      {maximum == null ? "-" : isLatency ? `${maximum.toFixed(2)}ms` : formatSpeed(maximum)}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">平均:</span>
                    <span>
                      {average == null ? "-" : isLatency ? `${average.toFixed(2)}ms` : formatSpeed(average)}
                    </span>
                  </div>
                  {isLatency && (
                    <>
                      <div className="flex justify-between"><span className="text-muted-foreground">抖动:</span><span>{record?.jitterMs?.toFixed(2) ?? "-"}ms</span></div>
                      <div className="flex justify-between"><span className="text-muted-foreground">丢包率:</span><span>{record?.packetLossPercent?.toFixed(1) ?? "-"}%</span></div>
                    </>
                  )}
                  {!isLatency && <div className="flex justify-between"><span className="text-muted-foreground">有效时长:</span><span>{record?.testDurationSeconds?.toFixed(1) ?? "-"} 秒</span></div>}
                </div>
              </div>

              {hasSamples ? (
                <div className="rounded-xl border border-border/40 bg-muted/20 p-3.5">
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-2">
                    {isLatency ? <Clock className="w-3 h-3" /> : <Download className="w-3 h-3" />}
                    {isLatency ? "单次延迟采样" : "逐秒速度采样"}
                  </div>
                  <div className="h-52 [&_.recharts-wrapper]:outline-none [&_.recharts-surface]:outline-none">
                    <ResponsiveContainer width="100%" height="100%">
                      {isLatency ? (
                        <BarChart data={chartData} accessibilityLayer margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                          <CartesianGrid stroke="var(--color-border)" strokeDasharray="3 5" vertical={false} opacity={0.65} />
                          <XAxis dataKey="label" fontSize={11} interval={tickInterval} axisLine={false} tickLine={false} tickMargin={8} />
                          <YAxis unit="ms" fontSize={11} axisLine={false} tickLine={false} width={48} />
                          <Tooltip contentStyle={tooltipStyle} cursor={{ fill: "var(--color-muted)", opacity: 0.45 }} formatter={(value) => [`${Number(value).toFixed(2)} ms`, "延迟"]} />
                          <Bar dataKey="value" fill="var(--color-primary)" radius={[4, 4, 0, 0]} />
                        </BarChart>
                      ) : (
                        <LineChart data={chartData} accessibilityLayer margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                          <CartesianGrid stroke="var(--color-border)" strokeDasharray="3 5" vertical={false} opacity={0.65} />
                          <XAxis dataKey="label" fontSize={11} interval={tickInterval} axisLine={false} tickLine={false} tickMargin={8} />
                          <YAxis unit="Mbps" fontSize={11} axisLine={false} tickLine={false} width={56} />
                          <Tooltip contentStyle={tooltipStyle} cursor={{ stroke: "var(--color-border)", strokeDasharray: "3 3" }} formatter={(value) => [formatSpeed(Number(value)), "速度"]} />
                          <Line type="monotone" dataKey="value" stroke="var(--color-primary)" strokeWidth={2.5} dot={{ r: 2, strokeWidth: 2, fill: "var(--color-background)" }} activeDot={{ r: 4, strokeWidth: 2 }} />
                        </LineChart>
                      )}
                    </ResponsiveContainer>
                  </div>
                </div>
              ) : <div className="py-8 text-center text-sm text-muted-foreground">该记录没有采样数据，升级相关设备后重新测试即可查看</div>}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
