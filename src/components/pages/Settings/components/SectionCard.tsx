/**
 * 设置页手风琴分组容器
 *
 * - 标题行可点击：展开对应分组，其余分组自动收起（单展开，由父级控制）
 * - 展开状态由父级管理并持久化到 localStorage
 * - 收起时标题右侧显示摘要（summary），一眼可见关键设置值
 * - badge 为 true 时标题旁显示红点（如「有可用更新」）
 * - 展开/收起使用 grid-template-rows 平滑过渡动画（内容保持挂载，滚动位置不丢失）
 * - 搜索模式（forceExpanded）下强制展开并隐藏箭头，由父级控制显隐
 */
import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

interface SectionCardProps {
  /** 分组图标 */
  icon: ReactNode;
  /** 分组标题（如「个性化」） */
  title: string;
  /** 是否展开（仅展开的分组渲染内容） */
  expanded: boolean;
  /** 点击标题：展开该分组（父级保证始终恰好一个展开） */
  onToggle: () => void;
  /** 收起状态显示的摘要（如 "v1.4.4 · 有新版"），展开时隐藏 */
  summary?: string;
  /** 标题旁红点提示（如检测到新版本） */
  badge?: boolean;
  /** 搜索模式：强制展开并隐藏箭头与摘要 */
  searching?: boolean;
  children: ReactNode;
}

export function SectionCard({
  icon,
  title,
  expanded,
  onToggle,
  summary,
  badge,
  searching,
  children,
}: SectionCardProps) {
  const isOpen = expanded || searching;

  return (
    <div className="space-y-3">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={isOpen}
        className="flex w-full cursor-pointer items-center gap-2 rounded-md px-1 py-0.5 text-left text-sm font-medium text-foreground transition-colors hover:text-foreground/80"
      >
        <span className="flex h-4 w-4 items-center justify-center">{icon}</span>
        <span>{title}</span>
        {badge && (
          <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-red-500" aria-label="有新内容" />
        )}
        {summary && !isOpen && (
          <span className="ml-2 min-w-0 truncate text-xs font-normal text-muted-foreground">
            {summary}
          </span>
        )}
        {!searching && (
          <ChevronDown
            className={cn(
              "ml-auto h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200",
              isOpen ? "rotate-180" : "rotate-0",
            )}
          />
        )}
      </button>
      {/* grid-rows 高度过渡：0fr→1fr 实现平滑展开/收起，内容保持挂载 */}
      <div
        className={cn(
          "grid transition-[grid-template-rows,opacity] duration-200 ease-out",
          isOpen ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
        )}
      >
        <div className="min-h-0 overflow-hidden">{children}</div>
      </div>
    </div>
  );
}
