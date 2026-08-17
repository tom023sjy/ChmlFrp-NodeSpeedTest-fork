/**
 * 关于页面
 *
 * 包含：版本信息、项目链接、工单反馈（应用内提交）、我的工单列表、免责声明。
 * 从原设置页 AboutSection 迁移并扩展工单功能。
 */
import { useState, useEffect } from "react";
import {
  Info,
  ExternalLink,
  Github,
  Bug,
  MessageSquare,
} from "lucide-react";
import {
  Item,
  ItemContent,
  ItemTitle,
  ItemDescription,
  ItemActions,
  ItemSeparator,
} from "@/components/ui/item";
import { Button } from "@/components/ui/button";
import { openUrl } from "@tauri-apps/plugin-opener";
import { OFFICIAL_LINKS } from "@/lib/api-endpoints";
import { updateService } from "@/services/updateService";
import { getCurrentUser } from "@/services/backendApi";
import { IssueSubmitDialog } from "./IssueSubmitDialog";
import { IssueListSection } from "./IssueListSection";
import { AnnouncementSection } from "./AnnouncementSection";
import type { Announcement } from "@/services/appRuntimeConfig";

const REPO_URL = OFFICIAL_LINKS.github;
const RELEASES_URL = OFFICIAL_LINKS.historyVersions;

interface AboutProps {
  announcements?: Announcement[];
  announcementRefreshing?: boolean;
  onRefreshAnnouncements?: () => void;
}

export function About({ announcements = [], announcementRefreshing = false, onRefreshAnnouncements = () => {} }: AboutProps) {
  const [currentVersion, setCurrentVersion] = useState<string>("");
  const [issueDialogOpen, setIssueDialogOpen] = useState(false);
  const [issueListKey, setIssueListKey] = useState(0);
  const user = getCurrentUser();
  const isLoggedIn = !!user;

  useEffect(() => {
    updateService.getCurrentVersion().then(setCurrentVersion);
  }, []);

  // 提交成功后刷新问题列表
  const handleIssueSuccess = () => {
    setIssueListKey((k) => k + 1);
  };

  return (
    <div className="flex flex-col h-full gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-medium text-foreground">关于</h1>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto visible-scrollbar space-y-6">
        <AnnouncementSection announcements={announcements} refreshing={announcementRefreshing} onRefresh={onRefreshAnnouncements} />
        {/* 版本与项目信息 */}
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            <Info className="w-4 h-4" />
            <span>版本信息</span>
          </div>
          <div className="rounded-lg bg-card overflow-hidden">
            <Item variant="outline" className="border-0">
              <ItemContent>
                <ItemTitle>版本</ItemTitle>
                <ItemDescription className="text-xs">
                  ChmlFrp 社区工具箱 {currentVersion || "—"}
                </ItemDescription>
              </ItemContent>
            </Item>

            <ItemSeparator />

            <Item variant="outline" className="border-0">
              <ItemContent>
                <ItemTitle>项目仓库</ItemTitle>
                <ItemDescription className="text-xs">
                  查看源码、Star 支持、提交 PR
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <button
                  onClick={() => void openUrl(REPO_URL)}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-foreground text-background hover:opacity-90 transition-opacity cursor-pointer"
                >
                  <Github className="w-3 h-3" />
                  GitHub
                </button>
              </ItemActions>
            </Item>

            <ItemSeparator />

            <Item variant="outline" className="border-0">
              <ItemContent>
                <ItemTitle>版本发布</ItemTitle>
                <ItemDescription className="text-xs">
                  查看历史版本更新日志
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <button
                  onClick={() => void openUrl(RELEASES_URL)}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-foreground text-background hover:opacity-90 transition-opacity cursor-pointer"
                >
                  <ExternalLink className="w-3 h-3" />
                  发布页面
                </button>
              </ItemActions>
            </Item>

            <ItemSeparator />

            <Item variant="outline" className="border-0">
              <ItemContent>
                <ItemTitle>ChmlFrp 官方</ItemTitle>
                <ItemDescription className="text-xs">
                  访问 ChmlFrp 官方网站与社区
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <button
                  onClick={() => void openUrl(OFFICIAL_LINKS.chmlfrp)}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-foreground text-background hover:opacity-90 transition-opacity cursor-pointer"
                >
                  <MessageSquare className="w-3 h-3" />
                  访问官网
                </button>
              </ItemActions>
            </Item>
          </div>
        </div>

        {/* 工单反馈 */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm font-medium text-foreground">
              <Bug className="w-4 h-4" />
              <span>工单反馈</span>
            </div>
            <Button
              size="sm"
              onClick={() => setIssueDialogOpen(true)}
              disabled={!isLoggedIn}
              title={!isLoggedIn ? "请先登录" : undefined}
            >
              <Bug className="w-3.5 h-3.5" />
              提交工单
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {isLoggedIn
              ? "遇到 Bug 或有功能建议？在这里直接提交工单，我们会及时处理并回复。"
              : "请先登录后再提交工单。"}
          </p>
        </div>

        {/* 我的工单列表 */}
        {isLoggedIn ? (
          <IssueListSection key={issueListKey} />
        ) : (
          <div className="flex flex-col items-center justify-center py-10 text-center">
            <MessageSquare className="w-10 h-10 text-muted-foreground/40 mb-3" />
            <p className="text-sm text-muted-foreground">请先登录后查看工单记录</p>
          </div>
        )}

        {/* 免责声明 */}
        <div className="space-y-1 pt-1 text-center">
          <p className="text-[11px] text-muted-foreground">
            本工具为社区开源项目，与 ChmlFrp 官方无隶属关系
          </p>
          <p className="text-[11px] text-muted-foreground/80">
            UI 设计基于{" "}
            <button
              type="button"
              onClick={() => void openUrl(OFFICIAL_LINKS.chmlfrpLauncher)}
              className="text-foreground/80 hover:text-primary transition-colors"
            >
              ChmlFrpLauncher
            </button>
            ，功能由{" "}
            <button
              type="button"
              onClick={() => void openUrl("https://github.com/zhengddzz")}
              className="font-medium text-foreground/80 hover:text-primary transition-colors"
            >
              zhengddzz
            </button>{" "}
            开发
          </p>
        </div>
      </div>

      <IssueSubmitDialog
        open={issueDialogOpen}
        onOpenChange={setIssueDialogOpen}
        onSuccess={handleIssueSuccess}
      />
    </div>
  );
}
