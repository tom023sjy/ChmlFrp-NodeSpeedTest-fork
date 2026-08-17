import { useState, useEffect, useCallback } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Plus, Pencil, Trash2, KeyRound, ExternalLink, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { openUrl } from "@tauri-apps/plugin-opener";
import { type StoredUser, getStoredUser } from "@/services/api";
import { useConfirm } from "@/components/ui/confirm-dialog";
import {
  dnsFailoverService,
  type DnsCredential,
  type DnsProviderKind,
} from "@/services/dnsFailoverService";
import { useEffectType, getCardClassName } from "@/lib/useEffectType";
import { reportUsage } from "@/services/backendApi";
import { dnsFailoverCloudService } from "@/services/dnsFailoverCloudService";

/** 已登录时上报事件，失败静默处理 */
function reportUsageIfLoggedIn(eventType: string, eventData?: Record<string, unknown>): void {
  if (!getStoredUser()?.accessToken) return;
  reportUsage({ eventType, eventData }).catch(() => {});
}

const PROVIDERS: { value: DnsProviderKind; label: string }[] = [
  { value: "dnspodCn", label: "DNSPod.cn（腾讯云 API 3.0）" },
  { value: "dnspodCom", label: "DNSPod.com（国际 Token）" },
  { value: "aliyun", label: "Aliyun（阿里云）" },
  { value: "cloudflare", label: "Cloudflare（API Token）" },
];

// 各服务商获取密钥的地址与简短说明
const PROVIDER_GUIDE: Record<
  DnsProviderKind,
  { url: string; urlLabel: string; tip: string }
> = {
  dnspodCn: {
    url: "https://console.dnspod.cn/account/token/apikey",
    urlLabel: "console.dnspod.cn",
    tip: "在「API 密钥」中创建密钥，获得 SecretId 与 SecretKey",
  },
  dnspodCom: {
    url: "https://www.dnspod.com/account/token",
    urlLabel: "dnspod.com",
    tip: "在「API Token」中创建 Token，格式为 ID,Token（用英文逗号分隔）",
  },
  aliyun: {
    url: "https://ram.console.aliyun.com/manage/ak",
    urlLabel: "ram.console.aliyun.com",
    tip: "在 RAM 访问控制中创建 AccessKey，获得 AccessKeyId 与 AccessKeySecret",
  },
  cloudflare: {
    url: "https://dash.cloudflare.com/profile/api-tokens",
    urlLabel: "dash.cloudflare.com",
    tip: "在「API Tokens」中创建 Token，需授予 Zone.DNS 编辑权限（Edit zone DNS）",
  },
};

const EMPTY: DnsCredential = {
  id: "",
  name: "",
  provider: "dnspodCn",
  secretId: "",
  secretKey: "",
  token: "",
  apiToken: "",
};

interface DnsCredentialsProps {
  user?: StoredUser | null;
}

export function DnsCredentials({ user }: DnsCredentialsProps) {
  const confirm = useConfirm();
  const effectType = useEffectType();
  const [list, setList] = useState<DnsCredential[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<DnsCredential | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [cloudMode, setCloudMode] = useState(false);

  const load = useCallback(async () => {
    if (!user?.username) {
      setLoading(false);
      setList([]);
      return;
    }
    setLoading(true);
    try {
      try {
        setList(await dnsFailoverCloudService.listCredentials());
        setCloudMode(true);
      } catch {
        setList(await dnsFailoverService.listCredentials(user.username));
        setCloudMode(false);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "加载凭证失败");
    } finally {
      setLoading(false);
    }
  }, [user?.username]);

  useEffect(() => {
    load();
  }, [load]);

  const handleAdd = () => {
    setEditing({ ...EMPTY, id: cloudMode ? "" : dnsFailoverService.genId() });
  };

  const handleEdit = (cred: DnsCredential) => {
    setEditing({ ...cred });
  };

  const handleSave = async () => {
    if (!editing) return;
    if (!user?.username) {
      toast.error("未登录");
      return;
    }
    if (!editing.name.trim()) {
      toast.error("请输入凭证名称");
      return;
    }
    const isCloudExisting = cloudMode && !!editing.id;
    if (!isCloudExisting && editing.provider === "dnspodCom" && !editing.token?.trim()) {
      toast.error("DNSPod.com 需要填写 Token（格式：ID,Token）");
      return;
    }
    if (
      !isCloudExisting &&
      (editing.provider === "dnspodCn" || editing.provider === "aliyun") &&
      (!editing.secretId?.trim() || !editing.secretKey?.trim())
    ) {
      toast.error("请填写 SecretId/AccessKeyId 与 SecretKey/AccessKeySecret");
      return;
    }
    if (!isCloudExisting && editing.provider === "cloudflare" && !editing.apiToken?.trim()) {
      toast.error("Cloudflare 需要填写 API Token");
      return;
    }
    // 保存前先验证凭证有效性，连接不上则中止保存
    setVerifying(true);
    try {
      if (cloudMode && editing.id) {
        await dnsFailoverCloudService.verifyCredential(editing);
      } else if (cloudMode) {
      } else if (!cloudMode) {
        await dnsFailoverService.verifyCredential(editing);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "验证失败";
      toast.error(`凭证验证失败：${msg}`);
      setVerifying(false);
      return;
    }
    setVerifying(false);
    try {
      if (cloudMode) {
        await dnsFailoverCloudService.saveCredential(editing);
      } else {
        await dnsFailoverService.saveCredential(user.username, editing);
      }
      toast.success("凭证已保存");
      // DNS 凭证保存（API 成功 + 凭证验证通过 = 真实结果）
      reportUsageIfLoggedIn("dns_credential_save", {
        provider: editing.provider,
      });
      setEditing(null);
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "保存失败");
    }
  };

  const handleDelete = async (cred: DnsCredential) => {
    if (!user?.username) {
      toast.error("未登录");
      return;
    }
    const ok = await confirm({
      title: "删除凭证",
      description: `确认删除凭证「${cred.name}」？关联的 DNS 容灾任务、DDNS 任务、SSL 证书申请可能失效。`,
      confirmText: "删除",
      variant: "destructive",
    });
    if (!ok) return;
    try {
      if (cloudMode) {
        await dnsFailoverCloudService.deleteCredential(cred.id);
      } else {
        await dnsFailoverService.deleteCredential(user.username, cred.id);
      }
      toast.success("已删除");
      // DNS 凭证删除（API 成功 = 真实结果）
      reportUsageIfLoggedIn("dns_credential_delete", {
        provider: cred.provider,
      });
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "删除失败");
    }
  };

  const isLoggedIn = !!user?.username;

  return (
    <div className="flex h-full flex-col">
      {/* 顶部标题栏 */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-border/40">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-primary/10 flex items-center justify-center">
            <KeyRound className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h1 className="text-base font-semibold text-foreground">DNS 服务商</h1>
            <p className="text-xs text-muted-foreground">
              集中管理 DNSPod、阿里云、Cloudflare 等服务商凭证，供 DNS 容灾、DDNS 解析和 SSL 证书申请使用
            </p>
          </div>
        </div>
        <Button
          size="sm"
          onClick={handleAdd}
          disabled={!isLoggedIn || loading}
          className="gap-1.5"
          title={!isLoggedIn ? "请先登录" : undefined}
        >
          <Plus className="w-3.5 h-3.5" />
          新增凭证
        </Button>
      </div>

      {/* 内容区 */}
      <div className="flex-1 min-h-0 overflow-y-auto visible-scrollbar">
        <div className="p-6">
          {loading ? (
            <div className="text-sm text-muted-foreground">加载中...</div>
          ) : !isLoggedIn ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <div className="w-12 h-12 rounded-2xl bg-muted/40 flex items-center justify-center mb-3">
                <KeyRound className="w-6 h-6 text-muted-foreground" />
              </div>
              <p className="text-sm text-muted-foreground">
                请先登录账户后查看和管理 DNS 服务商
              </p>
            </div>
          ) : list.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <div className="w-12 h-12 rounded-2xl bg-muted/40 flex items-center justify-center mb-3">
                <KeyRound className="w-6 h-6 text-muted-foreground" />
              </div>
              <p className="text-sm text-muted-foreground">
                暂无凭证，点击右上角「新增凭证」添加
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                支持 DNSPod.cn / DNSPod.com / 阿里云 / Cloudflare
              </p>
            </div>
          ) : (
            <div className="grid gap-2">
              {list.map((cred) => (
                <div
                  key={cred.id}
                  className={cn(
                    "flex items-center gap-3 p-3 rounded-xl border border-border/60 hover:bg-card/80 transition-colors",
                    getCardClassName(effectType),
                  )}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-foreground truncate">
                        {cred.name}
                      </span>
                      <span className="px-1.5 py-0.5 text-[10px] rounded bg-primary/10 text-primary font-medium">
                        {dnsFailoverService.providerLabel(cred.provider)}
                      </span>
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5 truncate">
                      {cred.provider === "dnspodCom"
                        ? `Token: ${cred.token ? "***" : "未设置"}`
                        : cred.provider === "cloudflare"
                          ? `API Token: ${cred.apiToken ? "***" : "未设置"}`
                          : `ID: ${cred.secretId || "未设置"}`}
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleEdit(cred)}
                      className="h-8 w-8 p-0"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleDelete(cred)}
                      className="h-8 w-8 p-0 text-destructive hover:text-destructive"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* 编辑对话框 */}
      <Dialog open={!!editing} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {list.find((c) => c.id === editing?.id) ? "编辑凭证" : "新增凭证"}
            </DialogTitle>
          </DialogHeader>
          {editing && (
            <div className="space-y-3 py-2">
              <div className="space-y-1.5">
                <Label>名称</Label>
                <Input
                  value={editing.name}
                  onChange={(e) =>
                    setEditing({ ...editing, name: e.target.value })
                  }
                  placeholder="如：我的腾讯云"
                />
              </div>
              <div className="space-y-1.5">
                <Label>服务商</Label>
                <Select
                  options={PROVIDERS.map((p) => ({ value: p.value, label: p.label }))}
                  value={editing.provider}
                  onChange={(v) =>
                    setEditing({
                      ...editing,
                      provider: v as DnsProviderKind,
                    })
                  }
                />
              </div>
              {/* 服务商密钥获取指引 */}
              {(() => {
                const guide = PROVIDER_GUIDE[editing.provider];
                return (
                  <div className="flex items-start gap-2 p-2.5 rounded-lg bg-muted/40 border border-border/50">
                    <KeyRound className="w-3.5 h-3.5 mt-0.5 text-muted-foreground flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-[11px] text-muted-foreground leading-relaxed">
                        {guide.tip}
                      </p>
                      <button
                        type="button"
                        onClick={() => {
                          void openUrl(guide.url);
                        }}
                        className="mt-1 inline-flex items-center gap-1 text-[11px] text-primary hover:opacity-80"
                      >
                        <ExternalLink className="w-3 h-3" />
                        {guide.urlLabel}
                      </button>
                    </div>
                  </div>
                );
              })()}
              {editing.provider === "dnspodCom" ? (
                <div className="space-y-1.5">
                  <Label>Token（格式：ID,Token）</Label>
                  <Input
                    value={editing.token || ""}
                    onChange={(e) =>
                      setEditing({ ...editing, token: e.target.value })
                    }
                    placeholder="12345,abcdef"
                  />
                </div>
              ) : editing.provider === "cloudflare" ? (
                <div className="space-y-1.5">
                  <Label>API Token</Label>
                  <Input
                    type="password"
                    value={editing.apiToken || ""}
                    onChange={(e) =>
                      setEditing({ ...editing, apiToken: e.target.value })
                    }
                    placeholder="••••••••••••••••"
                  />
                </div>
              ) : (
                <>
                  <div className="space-y-1.5">
                    <Label>
                      {editing.provider === "aliyun"
                        ? "AccessKeyId"
                        : "SecretId"}
                    </Label>
                    <Input
                      value={editing.secretId || ""}
                      onChange={(e) =>
                        setEditing({ ...editing, secretId: e.target.value })
                      }
                      placeholder={
                        editing.provider === "aliyun"
                          ? "LTAI5tXXXXXXXXXXXX"
                          : "AKIDxxxxxxxxxxxxxxxxxxxxx"
                      }
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>
                      {editing.provider === "aliyun"
                        ? "AccessKeySecret"
                        : "SecretKey"}
                    </Label>
                    <Input
                      type="password"
                      value={editing.secretKey || ""}
                      onChange={(e) =>
                        setEditing({ ...editing, secretKey: e.target.value })
                      }
                      placeholder="••••••••••••••••"
                    />
                  </div>
                </>
              )}
            </div>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setEditing(null)}
              disabled={verifying}
            >
              取消
            </Button>
            <Button onClick={handleSave} disabled={verifying}>
              {verifying ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                  验证中...
                </>
              ) : (
                "保存"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
