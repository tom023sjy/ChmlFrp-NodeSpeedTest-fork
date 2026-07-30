import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { getBetaTooltipEnabled } from "@/lib/settings-utils";
import { cn } from "@/lib/utils";

interface BetaTagProps {
  /**
   * Beta 提示内容，格式："Beta 测试功能：正文内容..."
   * 冒号前的部分作为标题（统一为「Beta 测试功能」），冒号后的部分作为正文。
   * 不传时使用默认文案。
   */
  betaTitle?: string;
  /** 自定义类名（用于控制 ml-auto 等布局） */
  className?: string;
  /** Tooltip 弹出方向，默认 "bottom" */
  side?: "top" | "right" | "bottom" | "left";
}

/** 默认 Beta 提示文案 */
const DEFAULT_BETA_TITLE =
  "Beta 测试功能：此功能仍在测试阶段，可能出现数据异常、功能不稳定等问题，开发者不承担任何由此造成的损失或责任，请谨慎使用。";

/**
 * 统一的 Beta 标签组件
 * - 在设置「Beta 功能提示」开启时：显示 amber 色 Beta 徽章 + 鼠标悬浮 500ms 后弹出 Tooltip
 * - 关闭时：仅显示 Beta 徽章，无 Tooltip
 * - 自动监听设置变化，无需手动刷新
 */
export function BetaTag({
  betaTitle = DEFAULT_BETA_TITLE,
  className,
  side = "bottom",
}: BetaTagProps) {
  const [enabled, setEnabled] = useState(() => getBetaTooltipEnabled());

  useEffect(() => {
    const handler = () => setEnabled(getBetaTooltipEnabled());
    window.addEventListener("betaTooltipChanged", handler);
    return () => window.removeEventListener("betaTooltipChanged", handler);
  }, []);

  // 解析 "Beta 测试功能：正文..." 格式
  const colonIdx = betaTitle.indexOf("：");
  const body = colonIdx >= 0 ? betaTitle.slice(colonIdx + 1) : betaTitle;

  const badgeClass = cn(
    "text-[9px] font-bold px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/20",
    enabled && "cursor-help",
    className,
  );

  if (!enabled) {
    return <span className={badgeClass}>Beta</span>;
  }

  return (
    <Tooltip delayDuration={500}>
      <TooltipTrigger asChild>
        <span className={badgeClass}>Beta</span>
      </TooltipTrigger>
      <TooltipContent side={side} className="max-w-[280px]">
        <div className="flex items-start gap-2 max-w-[260px]">
          <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5 text-amber-400" />
          <div className="space-y-1">
            <div className="font-semibold text-amber-400">Beta 测试功能</div>
            <div className="text-[11px] leading-relaxed opacity-90">{body}</div>
          </div>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
