import { useState, useEffect, useCallback } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Plus,
  RefreshCw,
  ShieldCheck,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  Clock,
  Trash2,
  ChevronRight,
  ScrollText,
  ChevronDown,
  ChevronUp,
  Minus,
} from "lucide-react";
import { toast } from "sonner";
import { type StoredUser } from "@/services/api";
import {
  sslService,
  type SslCertificate,
  type SslRequestParams,
  type SslRequestLog,
} from "@/services/sslService";
import {
  dnsFailoverService,
  type DnsCredential,
  CHMLFRP_CREDENTIAL_ID,
} from "@/services/dnsFailoverService";
import { ddnsService, type ChmlfrpAvailableDomain } from "@/services/ddnsService";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useSslProgress } from "./SslProgressContext";
import { reportUsage } from "@/services/backendApi";
import { getStoredUser } from "@/services/api";

interface SslManagementProps {
  user?: StoredUser | null;
}

/** 已登录时上报事件，失败静默处理 */
function reportUsageIfLoggedIn(eventType: string, eventData?: Record<string, unknown>): void {
  if (!getStoredUser()?.accessToken) return;
  reportUsage({ eventType, eventData }).catch(() => {});
}

/** 证书状态徽章 */
function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { variant: "default" | "secondary" | "destructive"; label: string; className?: string }> = {
    issued: {
      variant: "default",
      label: "已签发",
      className: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
    },
    pending: { variant: "secondary", label: "验证中" },
    failed: { variant: "destructive", label: "失败" },
    expired: { variant: "secondary", label: "已过期" },
  };
  const conf = map[status] || { variant: "secondary" as const, label: status };
  return (
    <Badge variant={conf.variant} className={conf.className}>
      {conf.label}
    </Badge>
  );
}

export function SslManagement({ user }: SslManagementProps) {
  const confirm = useConfirm();
  const { startRequest, registerOnComplete, registerOnLogSaved } = useSslProgress();
  const [activeTab, setActiveTab] = useState<"certs" | "logs">("certs");
  const [certs, setCerts] = useState<SslCertificate[]>([]);
  const [loading, setLoading] = useState(true);
  const [showRequest, setShowRequest] = useState(false);
  const [detail, setDetail] = useState<SslCertificate | null>(null);
  // 申请日志列表
  const [logs, setLogs] = useState<SslRequestLog[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const isLoggedIn = !!user?.username && !!user?.accessToken;

  const load = useCallback(async () => {
    if (!isLoggedIn) {
      setLoading(false);
      setCerts([]);
      return;
    }
    setLoading(true);
    try {
      setCerts(await sslService.list());
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "加载证书列表失败");
    } finally {
      setLoading(false);
    }
  }, [isLoggedIn]);

  const loadLogs = useCallback(async () => {
    if (!user?.username) {
      setLogs([]);
      return;
    }
    setLogsLoading(true);
    try {
      setLogs(await sslService.listLogs(user.username));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "加载申请日志失败");
    } finally {
      setLogsLoading(false);
    }
  }, [user?.username]);

  useEffect(() => {
    load();
  }, [load]);

  // 切换到日志 Tab 时加载日志
  useEffect(() => {
    if (activeTab === "logs") {
      loadLogs();
    }
  }, [activeTab, loadLogs]);

  // 把 load 注册给全局 Provider，申请完成后自动刷新列表
  useEffect(() => {
    registerOnComplete(load);
    return () => registerOnComplete(null);
  }, [registerOnComplete, load]);

  // 把 loadLogs 注册给全局 Provider，日志保存成功后自动刷新日志列表
  useEffect(() => {
    registerOnLogSaved(loadLogs);
    return () => registerOnLogSaved(null);
  }, [registerOnLogSaved, loadLogs]);

  return (
    <div className="flex h-full flex-col">
      {/* 顶部标题栏 */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-border/40">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-primary/10 flex items-center justify-center">
            <ShieldCheck className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h1 className="text-base font-semibold text-foreground">
              SSL 证书
              <span className="ml-2 text-[9px] font-bold px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/20 align-middle">
                Beta
              </span>
            </h1>
            <p className="text-xs text-muted-foreground">
              通过 DNS API 自动申请 SSL 证书（Let's Encrypt / ZeroSSL，DNS-01 验证）
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {activeTab === "certs" ? (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={load}
                disabled={!isLoggedIn || loading}
                title={!isLoggedIn ? "请先登录" : undefined}
              >
                <RefreshCw className={cn("w-3.5 h-3.5 mr-1.5", loading && "animate-spin")} />
                刷新
              </Button>
              <Button
                size="sm"
                onClick={() => setShowRequest(true)}
                disabled={!isLoggedIn}
                title={!isLoggedIn ? "请先登录" : undefined}
              >
                <Plus className="w-3.5 h-3.5 mr-1.5" />
                申请证书
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={loadLogs}
                disabled={!isLoggedIn || logsLoading}
                title={!isLoggedIn ? "请先登录" : undefined}
              >
                <RefreshCw className={cn("w-3.5 h-3.5 mr-1.5", logsLoading && "animate-spin")} />
                刷新
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={async () => {
                  if (!user?.username) return;
                  const ok = await confirm({
                    title: "清空申请日志",
                    description: "确认清空所有历史申请日志？此操作不可恢复。",
                    confirmText: "清空",
                    variant: "destructive",
                  });
                  if (!ok) return;
                  try {
                    await sslService.clearLogs(user.username);
                    toast.success("日志已清空");
                    loadLogs();
                  } catch (err) {
                    toast.error(err instanceof Error ? err.message : "清空失败");
                  }
                }}
                disabled={!isLoggedIn || logs.length === 0}
                title={!isLoggedIn ? "请先登录" : undefined}
              >
                <Trash2 className="w-3.5 h-3.5 mr-1.5" />
                清空
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Tab 切换栏 */}
      <div className="flex items-center gap-1 px-6 pt-3 border-b border-border/40">
        <button
          onClick={() => setActiveTab("certs")}
          className={cn(
            "flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 transition-colors",
            activeTab === "certs"
              ? "border-primary text-primary"
              : "border-transparent text-muted-foreground hover:text-foreground"
          )}
        >
          <ShieldCheck className="w-3.5 h-3.5" />
          证书列表
        </button>
        <button
          onClick={() => setActiveTab("logs")}
          className={cn(
            "flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 transition-colors",
            activeTab === "logs"
              ? "border-primary text-primary"
              : "border-transparent text-muted-foreground hover:text-foreground"
          )}
        >
          <ScrollText className="w-3.5 h-3.5" />
          申请日志
        </button>
      </div>

      {/* 内容区 */}
      <div className="flex-1 min-h-0 overflow-y-auto visible-scrollbar">
        <div className="p-6">
          {!isLoggedIn && (
            <div className="mb-4 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/30 text-xs text-amber-600 dark:text-amber-400">
              请先登录后使用 SSL 证书功能
            </div>
          )}

          {activeTab === "certs" ? (
            loading ? (
              <div className="flex items-center justify-center py-12 text-muted-foreground">
                <Loader2 className="w-5 h-5 animate-spin mr-2" />
                加载中...
              </div>
            ) : certs.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <div className="w-12 h-12 rounded-2xl bg-muted/40 flex items-center justify-center mb-3">
                  <ShieldCheck className="w-6 h-6 text-muted-foreground" />
                </div>
                <p className="text-sm text-muted-foreground">暂无证书，点击右上角申请</p>
              </div>
            ) : (
              <div className="space-y-3">
                {certs.map((cert) => (
                  <CertCard
                    key={cert.id}
                    cert={cert}
                    onClick={() => setDetail(cert)}
                    onDelete={async (e) => {
                      e.stopPropagation();
                      const ok = await confirm({
                        title: "删除证书",
                        description: `确认删除证书「${cert.domains}」？此操作不可恢复。为避免滥用证书，删除证书将会扣除 1000 积分。`,
                        confirmText: "删除",
                        variant: "destructive",
                      });
                      if (!ok) return;
                      try {
                        await sslService.delete(cert.id);
                        toast.success("证书已删除");
                        reportUsageIfLoggedIn("ssl_certificate_delete", {
                          provider: cert.provider,
                          status: cert.status,
                        });
                        load();
                      } catch (err) {
                        toast.error(err instanceof Error ? err.message : "删除失败");
                      }
                    }}
                  />
                ))}
              </div>
            )
          ) : (
            <LogsTab logs={logs} loading={logsLoading} isLoggedIn={isLoggedIn} />
          )}
        </div>
      </div>

      {/* 申请对话框 */}
      {showRequest && (
        <RequestDialog
          user={user}
          onClose={() => setShowRequest(false)}
          onStartAuto={async (params) => {
            if (!user?.username) return;
            setShowRequest(false);
            // SSL 证书申请提交埋点：仅在用户已登录时上报，失败静默不影响主流程
            // 同时兼容旧事件 ssl_request 与新事件 ssl_request_open
            if (user?.accessToken) {
              reportUsage({ eventType: "ssl_request" }).catch(() => {});
              reportUsageIfLoggedIn("ssl_request_open", {
                provider: params.provider,
                domain_count: params.domains.length,
              });
            }
            // 交给全局 Provider 托管进度状态与浮动卡片渲染
            await startRequest(params, user);
          }}
        />
      )}

      {/* 详情对话框 */}
      {detail && (
        <DetailDialog cert={detail} onClose={() => setDetail(null)} onRefresh={load} />
      )}
    </div>
  );
}

/** 申请日志 Tab 内容 */
function LogsTab({
  logs,
  loading,
  isLoggedIn,
}: {
  logs: SslRequestLog[];
  loading: boolean;
  isLoggedIn: boolean;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (!isLoggedIn) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <div className="w-12 h-12 rounded-2xl bg-muted/40 flex items-center justify-center mb-3">
          <ScrollText className="w-6 h-6 text-muted-foreground" />
        </div>
        <p className="text-sm text-muted-foreground">请先登录后查看申请日志</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground">
        <Loader2 className="w-5 h-5 animate-spin mr-2" />
        加载中...
      </div>
    );
  }

  if (logs.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <div className="w-12 h-12 rounded-2xl bg-muted/40 flex items-center justify-center mb-3">
          <ScrollText className="w-6 h-6 text-muted-foreground" />
        </div>
        <p className="text-sm text-muted-foreground">暂无申请日志</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {logs.map((log) => {
        const isExpanded = expandedId === log.id;
        const isIssued = log.finalStatus === "issued";
        const isFailed = log.finalStatus === "failed" || log.finalStatus === "error";
        return (
          <div
            key={log.id}
            className="rounded-xl border border-border/60 bg-card overflow-hidden"
          >
            {/* 折叠头部 */}
            <button
              onClick={() => setExpandedId(isExpanded ? null : log.id)}
              className="w-full flex items-center justify-between px-4 py-3 hover:bg-muted/40 transition-colors text-left"
            >
              <div className="flex items-center gap-2 min-w-0 flex-1">
                {isIssued ? (
                  <CheckCircle2 className="w-4 h-4 text-emerald-500 flex-shrink-0" />
                ) : isFailed ? (
                  <AlertTriangle className="w-4 h-4 text-destructive flex-shrink-0" />
                ) : (
                  <Clock className="w-4 h-4 text-amber-500 flex-shrink-0" />
                )}
                <span className="text-sm font-medium text-foreground truncate">
                  {log.domains}
                </span>
                <Badge
                  variant="secondary"
                  className={cn(
                    "flex-shrink-0",
                    isIssued
                      ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30"
                      : isFailed
                        ? "bg-destructive/10 text-destructive border-destructive/30"
                        : "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30"
                  )}
                >
                  {isIssued ? "成功" : isFailed ? "失败" : log.finalStatus}
                </Badge>
                <span className="text-[11px] text-muted-foreground flex-shrink-0">
                  {log.provider === "letsencrypt" ? "Let's Encrypt" : log.provider === "zerossl" ? "ZeroSSL" : log.provider}
                </span>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <span className="text-[11px] text-muted-foreground">
                  {new Date(log.finishedAt).toLocaleString("zh-CN")}
                </span>
                {isExpanded ? (
                  <ChevronUp className="w-4 h-4 text-muted-foreground" />
                ) : (
                  <ChevronDown className="w-4 h-4 text-muted-foreground" />
                )}
              </div>
            </button>
            {/* 展开内容：完整日志 */}
            {isExpanded && (
              <div className="border-t border-border/40 bg-muted/10 p-3">
                <div className="space-y-1 max-h-64 overflow-y-auto visible-scrollbar">
                  {log.logs.map((line, i) => (
                    <div
                      key={i}
                      className="text-[11px] font-mono text-foreground/75 leading-relaxed flex gap-2"
                    >
                      <span className="text-muted-foreground/60 select-none flex-shrink-0">
                        [{String(i + 1).padStart(2, "0")}]
                      </span>
                      <span className="break-all">{line}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** 证书卡片 */
function CertCard({
  cert,
  onClick,
  onDelete,
}: {
  cert: SslCertificate;
  onClick: () => void;
  onDelete: (e: React.MouseEvent) => void;
}) {
  return (
    <div
      onClick={onClick}
      className="w-full text-left rounded-xl border border-border/60 bg-card p-4 hover:border-primary/40 transition-colors cursor-pointer relative group"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="font-medium text-foreground truncate">{cert.domains}</span>
            <StatusBadge status={cert.status} />
          </div>
          <div className="text-xs text-muted-foreground space-y-0.5">
            <div className="flex items-center gap-1.5">
              <ShieldCheck className="w-3 h-3" />
              <span>
                {cert.provider === "letsencrypt" ? "Let's Encrypt" : cert.provider === "zerossl" ? "ZeroSSL" : cert.provider}
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <Clock className="w-3 h-3" />
              <span>创建：{new Date(cert.createdAt).toLocaleString("zh-CN")}</span>
            </div>
            {cert.issuedAt && (
              <div className="flex items-center gap-1.5">
                <CheckCircle2 className="w-3 h-3" />
                <span>签发：{new Date(cert.issuedAt).toLocaleString("zh-CN")}</span>
              </div>
            )}
            {cert.expiresAt && (
              <div className="flex items-center gap-1.5">
                <AlertTriangle className="w-3 h-3" />
                <span>过期：{new Date(cert.expiresAt).toLocaleString("zh-CN")}</span>
              </div>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <button
            onClick={onDelete}
            className="p-1.5 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors opacity-0 group-hover:opacity-100"
            title="删除证书"
          >
            <Trash2 className="w-4 h-4" />
          </button>
          <ChevronRight className="w-4 h-4 text-muted-foreground" />
        </div>
      </div>
    </div>
  );
}

/** 申请对话框 */
function RequestDialog({
  user,
  onClose,
  onStartAuto,
}: {
  user?: StoredUser | null;
  onClose: () => void;
  onStartAuto: (params: SslRequestParams) => void;
}) {
  const [provider, setProvider] = useState("letsencrypt");
  const [credentialId, setCredentialId] = useState(CHMLFRP_CREDENTIAL_ID);
  const [credentials, setCredentials] = useState<DnsCredential[]>([]);
  const [chmlfrpDomains, setChmlfrpDomains] = useState<ChmlfrpAvailableDomain[]>([]);
  // 域名条目列表：每行 = 主域名 + 子域名前缀（子域名为 * 表示泛域名）
  const [entries, setEntries] = useState<{ domain: string; subdomain: string }[]>(
    [{ domain: "", subdomain: "" }],
  );

  useEffect(() => {
    if (user?.username) {
      dnsFailoverService.listCredentials(user.username).then(setCredentials).catch(() => {});
    }
    ddnsService.listAvailableDomains().then(setChmlfrpDomains).catch(() => {});
  }, [user?.username]);

  const isChmlfrp = credentialId === CHMLFRP_CREDENTIAL_ID;

  // 切换凭证来源时重置域名条目
  const handleCredentialChange = (v: string) => {
    setCredentialId(v);
    setEntries([{ domain: "", subdomain: "" }]);
  };

  // 更新指定行的字段
  const updateEntry = (index: number, field: "domain" | "subdomain", value: string) => {
    setEntries((prev) => prev.map((e, i) => (i === index ? { ...e, [field]: value } : e)));
  };
  // 新增一行
  const addEntry = () => {
    setEntries((prev) => [...prev, { domain: "", subdomain: "" }]);
  };
  // 删除指定行
  const removeEntry = (index: number) => {
    setEntries((prev) => prev.filter((_, i) => i !== index));
  };

  // 将条目合并为完整域名列表
  const buildDomains = (): string[] => {
    const list: string[] = [];
    for (const e of entries) {
      const d = e.domain.trim();
      if (!d) continue;
      const s = e.subdomain.trim();
      if (!s) {
        list.push(d);
      } else if (s === "*") {
        list.push(`*.${d}`);
      } else {
        list.push(`${s}.${d}`);
      }
    }
    return list;
  };

  const handleStart = () => {
    const domains = buildDomains();
    if (domains.length === 0) {
      toast.error("请填写至少一个域名");
      return;
    }
    onStartAuto({
      provider,
      domains,
      challengeType: "dns01",
      credentialId,
    });
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto visible-scrollbar">
        <DialogHeader>
          <DialogTitle>申请 SSL 证书</DialogTitle>
          <DialogDescription>
            自动通过 DNS-01 验证申请证书（申请 → 添加 TXT → 验证 → 签发）
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          {/* 证书颁发机构 */}
          <div className="space-y-1.5">
            <Label>证书颁发机构</Label>
            <div className="flex gap-2">
              <Button
                variant={provider === "letsencrypt" ? "default" : "outline"}
                size="sm"
                onClick={() => setProvider("letsencrypt")}
              >
                Let's Encrypt
              </Button>
              <Button
                variant={provider === "zerossl" ? "default" : "outline"}
                size="sm"
                onClick={() => setProvider("zerossl")}
              >
                ZeroSSL
              </Button>
            </div>
          </div>

          {/* DNS 凭证选择 */}
          <div className="space-y-1.5">
            <Label>DNS 服务商</Label>
            <Select
              options={[
                { value: CHMLFRP_CREDENTIAL_ID, label: "ChmlFrp 免费域名（当前登录账户）" },
                ...credentials.map((c) => ({
                  value: c.id,
                  label: `${c.name}（${dnsFailoverService.providerLabel(c.provider)}）`,
                })),
              ]}
              value={credentialId}
              onChange={(v) => handleCredentialChange(String(v))}
              placeholder="选择 DNS 服务商"
            />
            {credentialId !== CHMLFRP_CREDENTIAL_ID && credentials.length === 0 && (
              <p className="text-xs text-muted-foreground">
                暂无 DNS 凭证，请在「DNS 服务商」页面创建
              </p>
            )}
          </div>

          {/* 域名条目列表 */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>申请域名</Label>
              <span className="text-[11px] text-muted-foreground">
                子域名填 * 表示泛域名，留空表示主域名本身
              </span>
            </div>
            {entries.map((entry, index) => (
              <div key={index} className="grid grid-cols-[1fr_1fr_auto] gap-2 items-center">
                {/* 主域名 */}
                {isChmlfrp ? (
                  <Select
                    options={chmlfrpDomains.map((d) => ({
                      value: d.domain,
                      label: d.domain + (d.icpFiling ? "（已备案）" : ""),
                    }))}
                    value={entry.domain}
                    onChange={(v) => updateEntry(index, "domain", String(v))}
                    placeholder="选择主域名"
                  />
                ) : (
                  <Input
                    value={entry.domain}
                    onChange={(e) => updateEntry(index, "domain", e.target.value)}
                    placeholder="主域名 example.com"
                  />
                )}
                {/* 子域名前缀 */}
                <Input
                  value={entry.subdomain}
                  onChange={(e) => updateEntry(index, "subdomain", e.target.value)}
                  placeholder="子域名（* 或 www 或留空）"
                />
                {/* 增减按钮 */}
                <div className="flex items-center gap-1">
                  {entries.length > 1 && (
                    <button
                      type="button"
                      onClick={() => removeEntry(index)}
                      className="p-1.5 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                      title="删除此行"
                    >
                      <Minus className="w-4 h-4" />
                    </button>
                  )}
                  {index === entries.length - 1 && (
                    <button
                      type="button"
                      onClick={addEntry}
                      className="p-1.5 rounded-md text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors"
                      title="新增域名"
                    >
                      <Plus className="w-4 h-4" />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button onClick={handleStart}>
            <ShieldCheck className="w-3.5 h-3.5 mr-1.5" />
            开始申请
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 详情对话框 */
function DetailDialog({
  cert,
  onClose,
  onRefresh,
}: {
  cert: SslCertificate;
  onClose: () => void;
  onRefresh: () => void;
}) {
  const confirm = useConfirm();
  const [detail, setDetail] = useState(cert);
  const [verifying, setVerifying] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const handleVerify = async () => {
    setVerifying(true);
    try {
      const updated = await sslService.verify(detail.id);
      setDetail(updated);
      toast.success("验证请求已发送");
      // 仅上报"开始验证"：verify API 成功返回 = 验证请求已被服务端接受
      // 最终验证结果通过 ssl_request_success/failure 体现，此处不上报 validation_success/failure
      reportUsageIfLoggedIn("ssl_validation_start", {
        provider: detail.provider,
        status: detail.status,
      });
      onRefresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "验证失败");
    } finally {
      setVerifying(false);
    }
  };

  const handleDelete = async () => {
    const ok = await confirm({
      title: "删除证书",
      description: `确认删除证书「${detail.domains}」？此操作不可恢复。为避免滥用证书，删除证书将会扣除 1000 积分。`,
      confirmText: "删除",
      variant: "destructive",
    });
    if (!ok) return;
    setDeleting(true);
    try {
      await sslService.delete(detail.id);
      toast.success("证书已删除");
      reportUsageIfLoggedIn("ssl_certificate_delete", {
        provider: detail.provider,
        status: detail.status,
      });
      onRefresh();
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "删除失败");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto visible-scrollbar">
        <DialogHeader>
          <DialogTitle>证书详情</DialogTitle>
          <DialogDescription>ID: {detail.id}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2 text-sm">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs text-muted-foreground">域名</Label>
              <p className="font-mono text-foreground">{detail.domains}</p>
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">状态</Label>
              <div className="mt-0.5"><StatusBadge status={detail.status} /></div>
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">CA</Label>
              <p className="text-foreground">
                {detail.provider === "letsencrypt" ? "Let's Encrypt" : detail.provider === "zerossl" ? "ZeroSSL" : detail.provider}
              </p>
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">验证方式</Label>
              <p className="text-foreground">{detail.challengeType || "—"}</p>
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">创建时间</Label>
              <p className="text-foreground">{new Date(detail.createdAt).toLocaleString("zh-CN")}</p>
            </div>
            {detail.issuedAt && (
              <div>
                <Label className="text-xs text-muted-foreground">签发时间</Label>
                <p className="text-foreground">{new Date(detail.issuedAt).toLocaleString("zh-CN")}</p>
              </div>
            )}
            {detail.expiresAt && (
              <div>
                <Label className="text-xs text-muted-foreground">过期时间</Label>
                <p className="text-foreground">{new Date(detail.expiresAt).toLocaleString("zh-CN")}</p>
              </div>
            )}
          </div>

          {detail.dnsRecordName && (
            <div className="p-3 rounded-lg border border-border/50 bg-muted/30 space-y-1">
              <Label className="text-xs text-muted-foreground">DNS 验证记录（TXT）</Label>
              <div className="font-mono text-xs text-foreground">
                名称：{detail.dnsRecordName}
              </div>
              <div className="font-mono text-xs text-foreground break-all">
                值：{detail.dnsRecordValue}
              </div>
            </div>
          )}

          {detail.errorMessage && (
            <div className="p-3 rounded-lg border border-destructive/30 bg-destructive/5">
              <div className="flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-destructive flex-shrink-0 mt-0.5" />
                <p className="text-xs text-destructive">{detail.errorMessage}</p>
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={handleDelete}
            disabled={deleting}
            className="text-destructive hover:text-destructive"
          >
            {deleting ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5 mr-1.5" />}
            删除
          </Button>
          <Button variant="outline" onClick={onClose}>关闭</Button>
          {detail.status !== "issued" && (
            <Button onClick={handleVerify} disabled={verifying}>
              {verifying ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5 mr-1.5" />}
              重新验证
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

