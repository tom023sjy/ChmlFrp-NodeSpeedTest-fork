import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Info, LoaderCircle, OctagonAlert, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { Announcement } from "@/services/appRuntimeConfig";
import { AnnouncementMarkdown } from "@/components/AnnouncementMarkdown";

interface AnnouncementDialogProps {
  announcements: Announcement[];
  onConfirm: () => void;
  onRefresh: () => Promise<void>;
}

export function AnnouncementDialog({ announcements, onConfirm, onRefresh }: AnnouncementDialogProps) {
  const [index, setIndex] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const touchStartX = useRef<number | null>(null);
  const announcement = announcements[index] ?? null;

  useEffect(() => {
    if (index >= announcements.length) setIndex(Math.max(announcements.length - 1, 0));
  }, [announcements.length, index]);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
    }
  };

  const moveTo = (nextIndex: number) => {
    setIndex(Math.max(0, Math.min(nextIndex, announcements.length - 1)));
  };

  const handlePrimary = () => {
    if (index < announcements.length - 1) moveTo(index + 1);
    else onConfirm();
  };

  const Icon = announcement?.level === "error"
    ? OctagonAlert
    : announcement?.level === "warning"
      ? AlertTriangle
      : Info;

  return (
    <Dialog open={announcement !== null} onOpenChange={(open) => !open && onConfirm()}>
      <DialogContent
        className="flex max-h-[85vh] min-h-0 w-[calc(100vw-2rem)] max-w-none flex-col overflow-hidden sm:w-[clamp(640px,70vw,960px)] sm:max-w-[calc(100vw-2rem)]"
        onTouchStart={(event) => { touchStartX.current = event.touches[0]?.clientX ?? null; }}
        onTouchEnd={(event) => {
          if (touchStartX.current === null) return;
          const distance = (event.changedTouches[0]?.clientX ?? touchStartX.current) - touchStartX.current;
          if (Math.abs(distance) >= 50) moveTo(index + (distance < 0 ? 1 : -1));
          touchStartX.current = null;
        }}
      >
        <DialogHeader>
          <div className="flex items-start justify-between gap-10">
            <DialogTitle className="flex items-center gap-2">
              <Icon className="h-5 w-5 text-primary" />
              {announcement?.title}
            </DialogTitle>
            <Button size="icon" variant="ghost" onClick={() => void handleRefresh()} disabled={refreshing} title="刷新公告">
              {refreshing ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            </Button>
          </div>
          <DialogDescription>
            {announcement?.publishedAt
              ? new Date(announcement.publishedAt).toLocaleString("zh-CN")
              : "应用公告"}
          </DialogDescription>
        </DialogHeader>
        <div key={`${announcement?.id}:${announcement?.revision}`} className="min-h-24 flex-1 animate-in slide-in-from-right-4 overflow-y-auto text-sm text-foreground visible-scrollbar">
          {announcement?.contentFormat === "markdown" ? (
            <AnnouncementMarkdown content={announcement.content} />
          ) : (
            <div className="whitespace-pre-wrap leading-6">{announcement?.content}</div>
          )}
        </div>
        <DialogFooter className="items-center sm:justify-between">
          <div className="flex items-center justify-center gap-2">
            {announcements.map((item, itemIndex) => (
              <button
                key={`${item.id}:${item.revision}`}
                type="button"
                aria-label={`查看第 ${itemIndex + 1} 条公告`}
                onClick={() => moveTo(itemIndex)}
                className={`h-2 rounded-full transition-all ${itemIndex === index ? "w-5 bg-foreground" : "w-2 bg-muted-foreground/30"}`}
              />
            ))}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => moveTo(index - 1)} disabled={index === 0}>上一条</Button>
            <Button onClick={handlePrimary}>{index === announcements.length - 1 ? "确认" : "下一个"}</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
