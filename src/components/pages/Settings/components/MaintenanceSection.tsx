import { useState } from "react";
import { Trash2, Loader2, FileText, Database, ScrollText } from "lucide-react";
import {
  Item,
  ItemContent,
  ItemTitle,
  ItemDescription,
  ItemActions,
} from "@/components/ui/item";
import { Button } from "@/components/ui/button";
import { BetaTag } from "@/components/ui/beta-tag";
import { toast } from "sonner";
import { fetchTunnels, deleteTunnel, getStoredUser } from "@/services/api";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { CleanTxtDialog } from "./CleanTxtDialog";
import { dnsFailoverService } from "@/services/dnsFailoverService";
import { ddnsService } from "@/services/ddnsService";
import { sslService } from "@/services/sslService";

/** 清除 TXT 解析记录的 Beta 提示文案 */
const CLEAN_TXT_BETA_TITLE =
  "Beta 测试功能：此功能仍在测试阶段，扫描和删除 DNS TXT 记录可能存在识别不准确的情况，删除后不可恢复，请谨慎使用。";

/** 清理本地缓存的 Beta 提示文案 */
const CLEAN_CACHE_BETA_TITLE =
  "Beta 测试功能：此功能仍在测试阶段，清理后节点测速结果、节点列表缓存、测试历史将被清除，需要重新测试或加载，请谨慎使用。";

/** 清理应用日志的 Beta 提示文案 */
const CLEAN_LOGS_BETA_TITLE =
  "Beta 测试功能：此功能仍在测试阶段，将清空 DNS 容灾、DDNS 解析、SSL 证书申请的历史日志，删除后不可恢复，请谨慎使用。";

// 临时隧道名称前缀（与 tunnelService.createTempTunnel 中保持一致）
const TEMP_TUNNEL_PREFIX = "speedtest";

/** 节点测速相关的 localStorage 键前缀（含账号隔离键与旧版全局键） */
const NODE_CACHE_KEYS = [
  "node_test_results",
  "node_list_cache",
  "node_test_history",
  "node_udp_cache",
] as const;

export function MaintenanceSection() {
  const confirm = useConfirm();
  const [cleaning, setCleaning] = useState(false);
  const [showCleanTxt, setShowCleanTxt] = useState(false);
  const [cleaningCache, setCleaningCache] = useState(false);
  const [cleaningLogs, setCleaningLogs] = useState(false);

  const handleCleanTempTunnels = async () => {
    const user = getStoredUser();
    if (!user) {
      toast.error("请先登录账户");
      return;
    }

    if (cleaning) return;
    setCleaning(true);

    try {
      const tunnels = await fetchTunnels();
      const tempTunnels = tunnels.filter((t) =>
        t.name?.toLowerCase().startsWith(TEMP_TUNNEL_PREFIX),
      );

      if (tempTunnels.length === 0) {
        toast.success("未发现遗留的临时隧道");
        return;
      }

      const confirmed = await confirm({
        title: "清除临时隧道",
        description: `发现 ${tempTunnels.length} 个临时隧道（前缀 ${TEMP_TUNNEL_PREFIX}_），确认全部删除？`,
        confirmText: "全部删除",
        variant: "destructive",
      });
      if (!confirmed) return;

      const results = await Promise.allSettled(
        tempTunnels.map((t) => deleteTunnel(t.id)),
      );
      const succeeded = results.filter((r) => r.status === "fulfilled").length;
      const failed = results.length - succeeded;

      if (failed === 0) {
        toast.success(`已清除全部 ${succeeded} 个临时隧道`);
      } else {
        toast.warning(`已删除 ${succeeded} 个，失败 ${failed} 个，可稍后重试`);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "清除临时隧道失败");
    } finally {
      setCleaning(false);
    }
  };

  /** 清理本地缓存：清除节点测速结果、节点列表缓存、测试历史、UDP 缓存 */
  const handleCleanCache = async () => {
    if (cleaningCache) return;

    const user = getStoredUser();
    const username = user?.username || "";

    const confirmed = await confirm({
      title: "清理本地缓存",
      description:
        "将清除节点测速结果、节点列表缓存、测试历史和 UDP 缓存，需重新测试或加载。确认清理？",
      confirmText: "清理",
      variant: "destructive",
    });
    if (!confirmed) return;

    setCleaningCache(true);
    try {
      let cleared = 0;
      // 清除账号隔离键（格式：key__username）和旧版全局键
      for (const key of NODE_CACHE_KEYS) {
        if (username) {
          localStorage.removeItem(`${key}__${username}`);
        }
        localStorage.removeItem(key);
        cleared++;
      }
      toast.success(`已清理 ${cleared} 类本地缓存`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "清理缓存失败");
    } finally {
      setCleaningCache(false);
    }
  };

  /** 清理应用日志：清除 DNS 容灾、DDNS 解析、SSL 证书申请的历史日志 */
  const handleCleanLogs = async () => {
    const user = getStoredUser();
    if (!user?.username) {
      toast.error("请先登录账户");
      return;
    }

    if (cleaningLogs) return;

    const confirmed = await confirm({
      title: "清理应用日志",
      description:
        "将清空 DNS 容灾、DDNS 解析、SSL 证书申请的全部历史日志，删除后不可恢复。确认清理？",
      confirmText: "清理",
      variant: "destructive",
    });
    if (!confirmed) return;

    setCleaningLogs(true);
    try {
      const results = await Promise.allSettled([
        dnsFailoverService.clearLogs(user.username),
        ddnsService.clearLogs(user.username),
        sslService.clearLogs(user.username),
      ]);
      const succeeded = results.filter((r) => r.status === "fulfilled").length;
      const failed = results.length - succeeded;

      if (failed === 0) {
        toast.success("已清空全部应用日志");
      } else {
        toast.warning(`已清理 ${succeeded} 类日志，失败 ${failed} 类`);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "清理日志失败");
    } finally {
      setCleaningLogs(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-sm font-medium text-foreground">
        <Trash2 className="w-4 h-4" />
        <span>数据维护</span>
      </div>
      <div className="rounded-lg bg-card overflow-hidden">
        <Item variant="outline" className="border-0">
          <ItemContent>
            <ItemTitle>清除临时隧道</ItemTitle>
            <ItemDescription className="text-xs">
              一键删除测速过程中遗留的临时隧道（名称以 {TEMP_TUNNEL_PREFIX}_
              开头）
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <Button
              size="sm"
              variant="destructive"
              disabled={cleaning}
              onClick={handleCleanTempTunnels}
              className="h-auto px-3 py-1.5 text-xs gap-1.5"
            >
              {cleaning ? (
                <>
                  <Loader2 className="w-3 h-3 animate-spin" />
                  清除中...
                </>
              ) : (
                "清除"
              )}
            </Button>
          </ItemActions>
        </Item>

        <Item variant="outline" className="border-0 border-t border-border/40">
          <ItemContent>
            <ItemTitle>
              清除 TXT 解析记录
              <BetaTag
                betaTitle={CLEAN_TXT_BETA_TITLE}
                className="ml-1.5 align-middle"
              />
            </ItemTitle>
            <ItemDescription className="text-xs">
              扫描所有 DNS 服务商下的 TXT 记录，清除 SSL
              申请遗留等不再需要的解析
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <Button
              size="sm"
              variant="destructive"
              onClick={() => setShowCleanTxt(true)}
              className="h-auto px-3 py-1.5 text-xs gap-1.5"
            >
              <FileText className="w-3 h-3" />
              扫描清除
            </Button>
          </ItemActions>
        </Item>

        <Item variant="outline" className="border-0 border-t border-border/40">
          <ItemContent>
            <ItemTitle>
              清理本地缓存
              <BetaTag
                betaTitle={CLEAN_CACHE_BETA_TITLE}
                className="ml-1.5 align-middle"
              />
            </ItemTitle>
            <ItemDescription className="text-xs">
              清除节点测速结果、节点列表缓存、测试历史和 UDP
              缓存，释放本地存储空间
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <Button
              size="sm"
              variant="destructive"
              disabled={cleaningCache}
              onClick={handleCleanCache}
              className="h-auto px-3 py-1.5 text-xs gap-1.5"
            >
              {cleaningCache ? (
                <>
                  <Loader2 className="w-3 h-3 animate-spin" />
                  清理中...
                </>
              ) : (
                <>
                  <Database className="w-3 h-3" />
                  清理
                </>
              )}
            </Button>
          </ItemActions>
        </Item>

        <Item variant="outline" className="border-0 border-t border-border/40">
          <ItemContent>
            <ItemTitle>
              清理应用日志
              <BetaTag
                betaTitle={CLEAN_LOGS_BETA_TITLE}
                className="ml-1.5 align-middle"
              />
            </ItemTitle>
            <ItemDescription className="text-xs">
              清空 DNS 容灾、DDNS 解析、SSL
              证书申请的历史日志（需登录账户）
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <Button
              size="sm"
              variant="destructive"
              disabled={cleaningLogs}
              onClick={handleCleanLogs}
              className="h-auto px-3 py-1.5 text-xs gap-1.5"
            >
              {cleaningLogs ? (
                <>
                  <Loader2 className="w-3 h-3 animate-spin" />
                  清理中...
                </>
              ) : (
                <>
                  <ScrollText className="w-3 h-3" />
                  清理
                </>
              )}
            </Button>
          </ItemActions>
        </Item>
      </div>

      {showCleanTxt && (
        <CleanTxtDialog open={showCleanTxt} onClose={() => setShowCleanTxt(false)} />
      )}
    </div>
  );
}
