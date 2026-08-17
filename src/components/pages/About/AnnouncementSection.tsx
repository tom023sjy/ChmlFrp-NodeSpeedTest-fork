import { useState } from "react";
import { AlertTriangle, Bell, CalendarDays, ChevronRight, Info, LoaderCircle, OctagonAlert, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Announcement } from "@/services/appRuntimeConfig";
import { AnnouncementDetailDialog } from "./AnnouncementDetailDialog";

interface AnnouncementSectionProps {
  announcements: Announcement[];
  refreshing: boolean;
  onRefresh: () => void;
}

const levelIcon = (level: Announcement["level"]) =>
  level === "error" ? OctagonAlert : level === "warning" ? AlertTriangle : Info;

export function AnnouncementSection({ announcements, refreshing, onRefresh }: AnnouncementSectionProps) {
  const [selectedAnnouncement, setSelectedAnnouncement] = useState<Announcement | null>(null);

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Bell className="h-4 w-4" />
          <span>应用公告</span>
        </div>
        <Button size="sm" variant="outline" onClick={onRefresh} disabled={refreshing}>
          {refreshing ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          刷新公告
        </Button>
      </div>
      {announcements.length === 0 ? (
        <div className="rounded-lg border border-border/60 px-4 py-5 text-sm text-muted-foreground">
          暂无有效公告
        </div>
      ) : (
        <div className="divide-y divide-border/60 overflow-hidden rounded-lg border border-border/60 bg-card">
          {announcements.map((announcement) => {
            const Icon = levelIcon(announcement.level);
            return (
              <button
                key={`${announcement.id}:${announcement.revision}`}
                type="button"
                className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/50"
                onClick={() => setSelectedAnnouncement(announcement)}
                title="查看公告详情"
              >
                <Icon className="h-4 w-4 shrink-0 text-primary" />
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{announcement.title}</span>
                <span className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
                  <CalendarDays className="h-3 w-3" />
                  {new Date(announcement.publishedAt).toLocaleDateString("zh-CN")}
                </span>
                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
              </button>
            );
          })}
        </div>
      )}
      <AnnouncementDetailDialog announcement={selectedAnnouncement} onClose={() => setSelectedAnnouncement(null)} />
    </section>
  );
}
