import { ScrollText } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { TestHistoryRecord } from "@/services/testHistoryService";

interface TestHistoryDetailDialogProps {
  record: TestHistoryRecord | null;
  onClose: () => void;
}

export function TestHistoryDetailDialog({ record, onClose }: TestHistoryDetailDialogProps) {
  return (
    <Dialog open={record !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ScrollText className="h-5 w-5" />
            测试记录详情
          </DialogTitle>
          <DialogDescription>{record?.nodeName ?? ""}</DialogDescription>
        </DialogHeader>
        {record && (
          <div className="min-h-0 space-y-4 overflow-y-auto visible-scrollbar">
            <div className="grid grid-cols-2 gap-3 rounded-lg bg-muted/50 p-3 text-sm">
              <div><span className="text-muted-foreground">设备方向：</span>{record.senderName} → {record.receiverName}</div>
              <div><span className="text-muted-foreground">测试时间：</span>{new Date(record.timestamp).toLocaleString()}</div>
              <div><span className="text-muted-foreground">延迟：</span>{record.latency == null ? "-" : `${record.latency.toFixed(2)} ms`}</div>
              <div><span className="text-muted-foreground">下载速度：</span>{record.downloadSpeed == null ? "-" : `${record.downloadSpeed.toFixed(2)} Mbps`}</div>
              <div><span className="text-muted-foreground">测试结果：</span>{record.success ? "成功" : "失败"}</div>
              <div><span className="text-muted-foreground">错误：</span>{record.error ?? "-"}</div>
            </div>
            <div className="rounded-lg bg-muted/30 p-3">
              <div className="mb-2 text-xs font-medium text-muted-foreground">测试日志</div>
              {record.logs?.length ? (
                <div className="max-h-72 space-y-1 overflow-y-auto font-mono text-xs visible-scrollbar">
                  {record.logs.map((log, index) => (
                    <div
                      key={`${log.timestamp}-${index}`}
                      className={log.type === "error" ? "text-red-600" : log.type === "warning" ? "text-yellow-600" : log.type === "success" ? "text-green-600" : "text-muted-foreground"}
                    >
                      [{new Date(log.timestamp).toLocaleTimeString()}] {log.message}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="py-6 text-center text-xs text-muted-foreground">该记录没有测试日志</div>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
