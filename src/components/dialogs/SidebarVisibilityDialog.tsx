import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  CONFIGURABLE_SIDEBAR_ITEMS,
  readHiddenSidebarItems,
  writeHiddenSidebarItems,
} from "@/services/sidebarPreferences";

interface SidebarVisibilityDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SidebarVisibilityDialog({ open, onOpenChange }: SidebarVisibilityDialogProps) {
  const [hiddenItems, setHiddenItems] = useState<string[]>([]);

  useEffect(() => {
    if (open) setHiddenItems(readHiddenSidebarItems());
  }, [open]);

  const toggleItem = (id: string) => {
    setHiddenItems((current) => current.includes(id)
      ? current.filter((item) => item !== id)
      : [...current, id]);
  };

  const handleSave = () => {
    writeHiddenSidebarItems(hiddenItems);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>侧边栏显示控制</DialogTitle>
          <DialogDescription>关闭不常用的项目，设置和关于始终保留。</DialogDescription>
        </DialogHeader>
        <div className="divide-y rounded-md border">
          {CONFIGURABLE_SIDEBAR_ITEMS.map((item) => {
            const visible = !hiddenItems.includes(item.id);
            return (
              <div key={item.id} className="flex min-h-12 items-center justify-between px-4">
                <span className="text-sm">{item.label}</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={visible}
                  onClick={() => toggleItem(item.id)}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${visible ? "bg-foreground" : "bg-muted"}`}
                >
                  <span className={`h-4 w-4 rounded-full bg-background shadow-sm transition-transform ${visible ? "translate-x-6" : "translate-x-1"}`} />
                </button>
              </div>
            );
          })}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={handleSave}>保存</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
