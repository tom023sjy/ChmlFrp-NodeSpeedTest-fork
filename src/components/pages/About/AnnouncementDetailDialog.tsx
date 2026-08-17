import { AlertTriangle, Info, OctagonAlert } from "lucide-react";
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

interface AnnouncementDetailDialogProps {
  announcement: Announcement | null;
  onClose: () => void;
}

export function AnnouncementDetailDialog({ announcement, onClose }: AnnouncementDetailDialogProps) {
  const Icon = announcement?.level === "error"
    ? OctagonAlert
    : announcement?.level === "warning"
      ? AlertTriangle
      : Info;

  return (
    <Dialog open={announcement !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[85vh] min-h-0 w-[calc(100vw-2rem)] max-w-none flex-col overflow-hidden sm:w-[clamp(640px,70vw,960px)] sm:max-w-[calc(100vw-2rem)]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Icon className="h-5 w-5 text-primary" />
            {announcement?.title}
          </DialogTitle>
          <DialogDescription>
            {announcement?.publishedAt
              ? new Date(announcement.publishedAt).toLocaleString("zh-CN")
              : "应用公告"}
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-24 flex-1 overflow-y-auto text-sm text-foreground visible-scrollbar">
          {announcement?.contentFormat === "markdown" ? (
            <AnnouncementMarkdown content={announcement.content} />
          ) : (
            <div className="whitespace-pre-wrap leading-6">{announcement?.content}</div>
          )}
        </div>
        <DialogFooter>
          <Button onClick={onClose}>关闭</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
