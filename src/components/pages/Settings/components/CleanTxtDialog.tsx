import { useState, useEffect, useCallback } from "react";
import { Loader2, Trash2, AlertTriangle, CheckSquare, Square, ShieldCheck } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { BetaTag } from "@/components/ui/beta-tag";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  dnsFailoverService,
  type TxtRecordItem,
} from "@/services/dnsFailoverService";
import { sslService, type SslCertificate } from "@/services/sslService";
import { getStoredUser } from "@/services/api";
import { useConfirm } from "@/components/ui/confirm-dialog";

interface CleanTxtDialogProps {
  open: boolean;
  onClose: () => void;
}

/** 清除 TXT 解析记录的 Beta 提示文案 */
const CLEAN_TXT_BETA_TITLE =
  "Beta 测试功能：此功能仍在测试阶段，扫描和删除 DNS TXT 记录可能存在识别不准确的情况，删除后不可恢复，请谨慎使用。";

/** 是否为 SSL 申请遗留的 TXT 验证记录（_acme-challenge 开头） */
function isSslLegacy(item: TxtRecordItem): boolean {
  return item.name.startsWith("_acme-challenge");
}

/**
 * 拼接 TXT 记录的完整域名（用于和证书 dnsRecordName 比对）
 * - name 为空时返回 domain 本身
 * - 否则返回 name.domain
 * - 自动去掉末尾的 .
 */
function buildFullRecordName(item: TxtRecordItem): string {
  const full = item.name && item.name !== "@"
    ? `${item.name}.${item.domain}`
    : item.domain;
  return full.replace(/\.+$/, "");
}

/**
 * 收集未被删除证书引用的 TXT 记录完整名集合
 * - 证书列表中所有能被列出的证书均视为「未删除」
 * - 证书的 dnsRecordName 即为申请时添加的 TXT 记录名（_acme-challenge.xxx）
 * - 这些 TXT 记录是证书续期/重新签发所需，不应被预选删除
 */
function collectActiveSslRecordNames(certs: SslCertificate[]): Set<string> {
  const set = new Set<string>();
  for (const cert of certs) {
    const name = cert.dnsRecordName?.trim().replace(/\.+$/, "");
    if (name) set.add(name);
  }
  return set;
}

export function CleanTxtDialog({ open, onClose }: CleanTxtDialogProps) {
  const confirm = useConfirm();
  const [loading, setLoading] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [items, setItems] = useState<TxtRecordItem[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  /** 当前未删除 SSL 证书引用的 TXT 记录完整名集合（用于排除预选） */
  const [activeSslNames, setActiveSslNames] = useState<Set<string>>(new Set());

  // 加载 TXT 记录 + SSL 证书列表
  const load = useCallback(async () => {
    const user = getStoredUser();
    if (!user?.username) {
      toast.error("请先登录账户");
      return;
    }
    setLoading(true);
    setSelected(new Set());
    try {
      // 并行拉取 TXT 记录与 SSL 证书列表
      const [list, certs] = await Promise.all([
        dnsFailoverService.listAllTxtRecords(user.username),
        sslService.list().catch((e) => {
          // 证书列表拉取失败不阻断主流程，仅提示
          console.warn("加载 SSL 证书列表失败：", e);
          return [] as SslCertificate[];
        }),
      ]);
      setItems(list);

      // 计算被未删除证书引用的 TXT 记录名集合
      const activeNames = collectActiveSslRecordNames(certs);
      setActiveSslNames(activeNames);

      // 预选 SSL 遗留的 TXT 记录（_acme-challenge 开头），
      // 但排除「当前未被删除证书」对应的记录（避免影响证书续期与自动更新）
      const preset = new Set<string>();
      list.forEach((item, idx) => {
        if (!isSslLegacy(item)) return;
        const fullName = buildFullRecordName(item);
        if (activeNames.has(fullName)) return; // 证书仍在使用，跳过
        preset.add(String(idx));
      });
      setSelected(preset);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "加载 TXT 记录失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      load();
    }
  }, [open, load]);

  // 切换勾选
  const toggle = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  // 全选/取消全选（不含证书使用中的记录）
  const toggleAll = () => {
    // 可勾选项 = 所有未被证书引用的记录
    const checkable = items
      .map((item, idx) => ({ item, idx: String(idx) }))
      .filter(({ item }) => !activeSslNames.has(buildFullRecordName(item)));
    const allSelected = checkable.length > 0 && checkable.every(({ idx }) => selected.has(idx));
    if (allSelected) {
      // 取消所有可勾选项
      setSelected((prev) => {
        const next = new Set(prev);
        checkable.forEach(({ idx }) => next.delete(idx));
        return next;
      });
    } else {
      // 选中所有可勾选项
      setSelected((prev) => {
        const next = new Set(prev);
        checkable.forEach(({ idx }) => next.add(idx));
        return next;
      });
    }
  };

  // 批量删除选中项
  const handleDelete = async () => {
    const user = getStoredUser();
    if (!user?.username) {
      toast.error("请先登录账户");
      return;
    }
    const targets = items.filter((_, idx) => selected.has(String(idx)));
    if (targets.length === 0) {
      toast.error("请勾选要删除的记录");
      return;
    }

    const ok = await confirm({
      title: "删除 TXT 记录",
      description: `确认删除选中的 ${targets.length} 条 TXT 记录？此操作不可恢复。`,
      confirmText: "删除",
      variant: "destructive",
    });
    if (!ok) return;

    setDeleting(true);
    let succeeded = 0;
    let failed = 0;
    // 串行删除，避免并发限制
    for (const item of targets) {
      try {
        await dnsFailoverService.deleteTxtRecord(
          user.username,
          item.credentialId,
          item.domain,
          item.recordId,
        );
        succeeded++;
      } catch {
        failed++;
      }
    }
    setDeleting(false);
    if (failed === 0) {
      toast.success(`已删除 ${succeeded} 条 TXT 记录`);
    } else {
      toast.warning(`已删除 ${succeeded} 条，失败 ${failed} 条`);
    }
    // 重新加载
    load();
  };

  // 按凭证分组展示
  const groups = items.reduce<Record<string, TxtRecordItem[]>>((acc, item, idx) => {
    const key = item.credentialLabel;
    if (!acc[key]) acc[key] = [];
    (acc[key] as TxtRecordItem[]).push({ ...item, _idx: idx } as TxtRecordItem & { _idx: number });
    return acc;
  }, {});

  // 统计被证书引用的记录数量（用于提示）
  const activeCount = items.filter((item) => activeSslNames.has(buildFullRecordName(item))).length;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center">
            清除 TXT 解析记录
            <BetaTag
              betaTitle={CLEAN_TXT_BETA_TITLE}
              className="ml-2 align-middle"
            />
          </DialogTitle>
          <DialogDescription>
            扫描所有 DNS 服务商下的 TXT 记录，已自动预选 SSL 申请遗留的 _acme-challenge 记录，并排除当前 SSL 证书仍在使用的记录
          </DialogDescription>
        </DialogHeader>

        {/* 工具栏 */}
        <div className="flex items-center justify-between px-1 py-2 border-b border-border/40">
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            {loading ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                扫描中...
              </>
            ) : (
              <>
                <span>共 {items.length} 条，已选 {selected.size} 条</span>
                {activeCount > 0 && (
                  <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                    <ShieldCheck className="w-3 h-3" />
                    {activeCount} 条 SSL 证书使用中（已自动排除）
                  </span>
                )}
              </>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={toggleAll}
              disabled={loading || items.length === 0}
              className="h-7 text-xs"
            >
              {selected.size === items.length && items.length > 0 ? "取消全选" : "全选"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={load}
              disabled={loading}
              className="h-7 text-xs"
            >
              重新扫描
            </Button>
          </div>
        </div>

        {/* 列表区 */}
        <div className="flex-1 min-h-0 overflow-y-auto visible-scrollbar px-1 py-2">
          {loading ? (
            <div className="flex items-center justify-center py-12 text-muted-foreground text-sm">
              <Loader2 className="w-5 h-5 animate-spin mr-2" />
              正在扫描所有 DNS 服务商的 TXT 记录...
            </div>
          ) : items.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <CheckSquare className="w-8 h-8 text-emerald-500 mb-2" />
              <p className="text-sm text-muted-foreground">未发现任何 TXT 记录</p>
            </div>
          ) : (
            <div className="space-y-3">
              {Object.entries(groups).map(([label, groupItems]) => (
                <div key={label}>
                  <div className="text-xs font-medium text-foreground px-1 py-1.5 sticky top-0 bg-card">
                    {label}
                  </div>
                  <div className="space-y-1">
                    {(groupItems as (TxtRecordItem & { _idx: number })[]).map((item) => {
                      const key = String(item._idx);
                      const checked = selected.has(key);
                      const legacy = isSslLegacy(item);
                      const isActive = activeSslNames.has(buildFullRecordName(item));
                      return (
                        <button
                          key={key}
                          onClick={() => toggle(key)}
                          className={cn(
                            "w-full flex items-start gap-2 px-2 py-2 rounded-md text-left transition-colors border",
                            checked
                              ? "bg-destructive/5 border-destructive/30"
                              : "hover:bg-muted/40 border-transparent",
                            isActive && "opacity-90",
                          )}
                          title={isActive ? "此记录正被 SSL 证书使用，删除将影响证书自动更新/续期，请谨慎操作" : undefined}
                        >
                          {checked ? (
                            <CheckSquare className="w-4 h-4 text-destructive flex-shrink-0 mt-0.5" />
                          ) : (
                            <Square className="w-4 h-4 text-muted-foreground flex-shrink-0 mt-0.5" />
                          )}
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-xs font-mono text-foreground">
                                {item.name || "@"}
                              </span>
                              <span className="text-[10px] text-muted-foreground">
                                .{item.domain}
                              </span>
                              {isActive && (
                                <Badge
                                  variant="secondary"
                                  className="text-[9px] py-0 h-4 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30 gap-0.5"
                                >
                                  <ShieldCheck className="w-2.5 h-2.5" />
                                  证书使用中
                                </Badge>
                              )}
                              {!isActive && legacy && (
                                <Badge
                                  variant="secondary"
                                  className="text-[9px] py-0 h-4 bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30"
                                >
                                  SSL 遗留
                                </Badge>
                              )}
                            </div>
                            <div className="text-[10px] font-mono text-muted-foreground mt-0.5 break-all">
                              {item.value}
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 底部操作 */}
        <DialogFooter className="border-t border-border/40 pt-3">
          <div className="flex items-center gap-2 w-full">
            {selected.size > 0 && (
              <div className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400 mr-auto">
                <AlertTriangle className="w-3.5 h-3.5" />
                删除后不可恢复
              </div>
            )}
            <Button variant="outline" onClick={onClose} disabled={deleting}>
              关闭
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={loading || deleting || selected.size === 0}
            >
              {deleting ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                  删除中...
                </>
              ) : (
                <>
                  <Trash2 className="w-3.5 h-3.5 mr-1.5" />
                  删除选中（{selected.size}）
                </>
              )}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
