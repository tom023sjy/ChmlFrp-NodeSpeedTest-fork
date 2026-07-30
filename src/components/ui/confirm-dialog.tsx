import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, Info, Trash2, type LucideIcon } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

/**
 * 确认对话框选项
 */
export interface ConfirmOptions {
  /** 标题，默认「确认操作」 */
  title?: ReactNode;
  /** 描述内容，可为字符串或自定义 JSX */
  description?: ReactNode;
  /** 确认按钮文字，默认「确认」 */
  confirmText?: string;
  /** 取消按钮文字，默认「取消」 */
  cancelText?: string;
  /**
   * 视觉风格：
   * - destructive：红色危险按钮 + 警告图标（删除、清空等不可恢复操作）
   * - warning：琥珀色警告图标 + 默认按钮（警告类操作）
   * - info：蓝色信息图标 + 默认按钮（普通确认）
   */
  variant?: "destructive" | "warning" | "info";
  /** 自定义图标，覆盖 variant 默认图标 */
  icon?: LucideIcon;
  /** 是否显示右上角关闭按钮，默认 false（避免误触） */
  showCloseButton?: boolean;
}

interface ConfirmContextValue {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
}

const ConfirmContext = createContext<ConfirmContextValue | null>(null);

const VARIANT_CONFIG: Record<
  NonNullable<ConfirmOptions["variant"]>,
  { icon: LucideIcon; iconClass: string; buttonVariant: "destructive" | "default" }
> = {
  destructive: { icon: Trash2, iconClass: "text-destructive", buttonVariant: "destructive" },
  warning: { icon: AlertTriangle, iconClass: "text-amber-500", buttonVariant: "default" },
  info: { icon: Info, iconClass: "text-blue-500", buttonVariant: "default" },
};

/**
 * 确认对话框 Provider：在根组件包裹后，子组件可通过 useConfirm() 调用。
 *
 * 用法：
 * ```tsx
 * const confirm = useConfirm();
 * const ok = await confirm({
 *   title: "删除证书",
 *   description: "此操作不可恢复，确认删除？",
 *   variant: "destructive",
 * });
 * if (!ok) return;
 * ```
 */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const [options, setOptions] = useState<ConfirmOptions>({});
  const resolverRef = useRef<((value: boolean) => void) | null>(null);

  const confirm = useCallback((opts: ConfirmOptions) => {
    setOptions(opts);
    setIsOpen(true);
    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve;
    });
  }, []);

  const handleClose = useCallback(
    (result: boolean) => {
      setIsOpen(false);
      const resolver = resolverRef.current;
      resolverRef.current = null;
      if (resolver) resolver(result);
    },
    [],
  );

  // 防止 Promise 未 resolve（如快速连点）：每次关闭都清理
  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        handleClose(false);
      }
    },
    [handleClose],
  );

  const variant = options.variant ?? "info";
  const config = VARIANT_CONFIG[variant];
  const Icon = options.icon ?? config.icon;

  return (
    <ConfirmContext.Provider value={{ confirm }}>
      {children}
      <Dialog open={isOpen} onOpenChange={handleOpenChange}>
        <DialogContent
          showCloseButton={options.showCloseButton ?? false}
          className="max-w-md"
          onEscapeKeyDown={() => handleClose(false)}
          onPointerDownOutside={(e) => {
            // 阻止点击遮罩关闭，避免误触导致确认丢失
            e.preventDefault();
          }}
        >
          <DialogHeader>
            <DialogTitle className="flex items-start gap-3">
              <Icon className={`h-5 w-5 flex-shrink-0 mt-0.5 ${config.iconClass}`} />
              <span className="flex-1">{options.title ?? "确认操作"}</span>
            </DialogTitle>
            {options.description !== undefined && (
              <DialogDescription asChild>
                <div className="text-sm text-muted-foreground pl-8">
                  {options.description}
                </div>
              </DialogDescription>
            )}
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={() => handleClose(false)}
              autoFocus
            >
              {options.cancelText ?? "取消"}
            </Button>
            <Button
              variant={config.buttonVariant}
              onClick={() => handleClose(true)}
            >
              {options.confirmText ?? "确认"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ConfirmContext.Provider>
  );
}

/**
 * 使用确认对话框
 * @returns confirm 函数，返回 Promise<boolean>，true 表示用户确认
 */
export function useConfirm(): (options: ConfirmOptions) => Promise<boolean> {
  const ctx = useContext(ConfirmContext);
  if (!ctx) {
    throw new Error("useConfirm 必须在 ConfirmProvider 内使用");
  }
  return ctx.confirm;
}


