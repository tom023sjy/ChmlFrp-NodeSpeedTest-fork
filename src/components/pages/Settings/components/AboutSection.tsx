import { Info, ExternalLink, Github, Bug, MessageSquare } from "lucide-react";
import {
  Item,
  ItemContent,
  ItemTitle,
  ItemDescription,
  ItemActions,
  ItemSeparator,
} from "@/components/ui/item";
import { openUrl } from "@tauri-apps/plugin-opener";

const REPO_URL = "https://github.com/zhengddzz/ChmlFrp-Community-Toolbox";
const ISSUES_URL = `${REPO_URL}/issues`;
// 历史版本更新日志（独立站，与 GitHub Releases 内容同步）
const RELEASES_URL = "https://u.zdzz.top/app/node-selector";

export interface AboutSectionProps {
  /** 应用当前版本号 */
  currentVersion: string;
}

export function AboutSection({ currentVersion }: AboutSectionProps) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-sm font-medium text-foreground">
        <Info className="w-4 h-4" />
        <span>关于</span>
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
            <ItemTitle>问题反馈</ItemTitle>
            <ItemDescription className="text-xs">
              在 GitHub Issues 提交 Bug 报告或功能建议
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <button
              onClick={() => void openUrl(ISSUES_URL)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-foreground text-background hover:opacity-90 transition-opacity cursor-pointer"
            >
              <Bug className="w-3 h-3" />
              前往反馈
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
              onClick={() => void openUrl("https://www.chmlfrp.net")}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-foreground text-background hover:opacity-90 transition-opacity cursor-pointer"
            >
              <MessageSquare className="w-3 h-3" />
              访问官网
            </button>
          </ItemActions>
        </Item>
      </div>
      <p className="text-[11px] text-muted-foreground text-center pt-1">
        本工具为社区开源项目，与 ChmlFrp 官方无隶属关系
      </p>
    </div>
  );
}
