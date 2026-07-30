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
  Pencil,
  Trash2,
  RefreshCw,
  Globe,
  Network,
  Clock,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Trash,
  KeyRound,
} from "lucide-react";
import { toast } from "sonner";
import { listen } from "@tauri-apps/api/event";
import { type StoredUser } from "@/services/api";
import { useConfirm } from "@/components/ui/confirm-dialog";
import {
  ddnsService,
  type DdnsTask,
  type DdnsLog,
  type ChmlfrpAvailableDomain,
  type NetworkInterface,
  type DnsCredential,
  type CredentialSource,
  type ScheduleMode,
  type TimeInterval,
} from "@/services/ddnsService";
import { dnsFailoverService } from "@/services/dnsFailoverService";

interface DnsManagementProps {
  user?: StoredUser | null;
}

type TabId = "tasks" | "logs";

const TABS: { id: TabId; label: string; icon: typeof Globe }[] = [
  { id: "tasks", label: "DDNS 任务", icon: Network },
  { id: "logs", label: "日志", icon: Clock },
];

/** 默认新任务 */
function createEmptyTask(): DdnsTask {
  return {
    id: "",
    name: "",
    domain: "",
    record: "",
    recordType: "A",
    credentialSource: { type: "chmlfrp" },
    interface: "",
    schedule: { type: "intervals", intervals: [], fallbackIntervalSecs: 300 },
    enabled: true,
    lastCheck: null,
    lastIp: null,
    lastUpdatedIp: null,
    lastMessage: null,
  };
}

/** 默认时间段 */
function createEmptyInterval(): TimeInterval {
  return { start: "08:00", end: "22:00", intervalSecs: 300 };
}

/** 间隔秒数预设选项 */
const INTERVAL_PRESETS = [
  { value: 60, label: "1 分钟" },
  { value: 300, label: "5 分钟" },
  { value: 600, label: "10 分钟" },
  { value: 1800, label: "30 分钟" },
  { value: 3600, label: "1 小时" },
];

export function DnsManagement({ user }: DnsManagementProps) {
  const [activeTab, setActiveTab] = useState<TabId>("tasks");
  const isLoggedIn = !!user?.username && !!user?.accessToken;

  return (
    <div className="flex h-full flex-col">
      {/* 顶部标题栏 */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-border/40">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-primary/10 flex items-center justify-center">
            <Globe className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h1 className="text-base font-semibold text-foreground">DDNS 解析</h1>
            <p className="text-xs text-muted-foreground">
              监控本机网卡 IP 变化，自动更新 DNS 解析（支持 ChmlFrp 免费域名与 DNSPod/Aliyun/Cloudflare 等凭证，A/AAAA 记录）
            </p>
          </div>
        </div>
      </div>

      {/* Tab 切换 */}
      <div className="flex items-center gap-1 px-6 pt-3 border-b border-border/40">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const active = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={cn(
                "flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 transition-colors",
                active
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon className="w-3.5 h-3.5" />
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* 内容区 */}
      <div className="flex-1 min-h-0 overflow-y-auto visible-scrollbar">
        <div className="p-6">
          {!isLoggedIn && (
            <div className="mb-4 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/30 text-xs text-amber-600 dark:text-amber-400">
              请先登录后使用 DDNS 功能
            </div>
          )}
          {activeTab === "tasks" && <TasksTab user={user} isLoggedIn={isLoggedIn} />}
          {activeTab === "logs" && <LogsTab user={user} isLoggedIn={isLoggedIn} />}
        </div>
      </div>
    </div>
  );
}

// ===== 任务管理 Tab =====

interface TasksTabProps {
  user?: StoredUser | null;
  isLoggedIn: boolean;
}

function TasksTab({ user, isLoggedIn }: TasksTabProps) {
  const confirm = useConfirm();
  const [tasks, setTasks] = useState<DdnsTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<DdnsTask | null>(null);

  const load = useCallback(async () => {
    if (!user?.username) {
      setLoading(false);
      setTasks([]);
      return;
    }
    setLoading(true);
    try {
      setTasks(await ddnsService.listTasks(user.username));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "加载任务失败");
    } finally {
      setLoading(false);
    }
  }, [user?.username]);

  useEffect(() => {
    load();
  }, [load]);

  // 监听后端推送的刷新事件
  useEffect(() => {
    const unlisten = listen<{ refresh: boolean }>("ddns-task-event", () => {
      load();
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [load]);

  const handleToggle = async (task: DdnsTask) => {
    if (!user?.username) return;
    try {
      await ddnsService.saveTask(user.username, { ...task, enabled: !task.enabled });
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "操作失败");
    }
  };

  const handleDelete = async (task: DdnsTask) => {
    if (!user?.username) return;
    const ok = await confirm({
      title: "删除任务",
      description: `确认删除任务「${task.name}」？`,
      confirmText: "删除",
      variant: "destructive",
    });
    if (!ok) return;
    try {
      await ddnsService.deleteTask(user.username, task.id);
      toast.success("已删除");
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "删除失败");
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-foreground">DDNS 任务</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            配置本机网卡 IP 监控，IP 变化时自动更新解析
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={load}
            disabled={!isLoggedIn}
            title={!isLoggedIn ? "请先登录" : undefined}
          >
            <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
            刷新
          </Button>
          <Button
            size="sm"
            onClick={() => setEditing(createEmptyTask())}
            disabled={!isLoggedIn}
            title={!isLoggedIn ? "请先登录" : undefined}
          >
            <Plus className="w-3.5 h-3.5 mr-1.5" />
            新建任务
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12 text-muted-foreground">
          <Loader2 className="w-5 h-5 animate-spin mr-2" />
          加载中...
        </div>
      ) : tasks.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <div className="w-12 h-12 rounded-2xl bg-muted/40 flex items-center justify-center mb-3">
            <Network className="w-6 h-6 text-muted-foreground" />
          </div>
          <p className="text-sm text-muted-foreground">暂无任务，点击右上角新建</p>
        </div>
      ) : (
        <div className="space-y-3">
          {tasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              onEdit={() => setEditing(task)}
              onToggle={() => handleToggle(task)}
              onDelete={() => handleDelete(task)}
            />
          ))}
        </div>
      )}

      {editing && (
        <TaskEditDialog
          task={editing}
          user={user}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}
    </div>
  );
}

function TaskCard({
  task,
  onEdit,
  onToggle,
  onDelete,
}: {
  task: DdnsTask;
  onEdit: () => void;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const scheduleText =
    task.schedule.type === "scheduled"
      ? `定时：${task.schedule.times.join("、") || "未设置"}`
      : `间隔：${task.schedule.intervals.length} 个时段，默认 ${Math.floor(task.schedule.fallbackIntervalSecs / 60)} 分钟`;

  const credText =
    task.credentialSource.type === "chmlfrp"
      ? "ChmlFrp 免费域名"
      : `DNS 凭证：${task.credentialSource.credentialId.slice(0, 8)}...`;

  return (
    <div className="rounded-xl border border-border/60 bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="font-medium text-foreground truncate">{task.name}</span>
            {task.enabled ? (
              <Badge className="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30">
                启用
              </Badge>
            ) : (
              <Badge variant="secondary">停用</Badge>
            )}
          </div>
          <div className="text-xs text-muted-foreground space-y-0.5">
            <div className="flex items-center gap-1.5">
              <Globe className="w-3 h-3" />
              <span className="font-mono">
                {task.record || "@"}.{task.domain}
              </span>
              <span className="px-1.5 py-0.5 rounded bg-muted text-foreground/70">{task.recordType}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <Network className="w-3 h-3" />
              <span>{task.interface || "自动选择网卡"}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <Clock className="w-3 h-3" />
              <span>{scheduleText}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <KeyRound className="w-3 h-3" />
              <span>{credText}</span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <Button variant="ghost" size="sm" onClick={onToggle} title={task.enabled ? "停用" : "启用"}>
            {task.enabled ? <XCircle className="w-4 h-4" /> : <CheckCircle2 className="w-4 h-4" />}
          </Button>
          <Button variant="ghost" size="sm" onClick={onEdit} title="编辑">
            <Pencil className="w-4 h-4" />
          </Button>
          <Button variant="ghost" size="sm" onClick={onDelete} title="删除">
            <Trash2 className="w-4 h-4 text-destructive" />
          </Button>
        </div>
      </div>

      {/* 运行时状态 */}
      <div className="mt-3 pt-3 border-t border-border/40 grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
        <div>
          <div className="text-muted-foreground">上次检查</div>
          <div className="text-foreground mt-0.5">
            {task.lastCheck ? new Date(task.lastCheck).toLocaleString("zh-CN") : "—"}
          </div>
        </div>
        <div>
          <div className="text-muted-foreground">当前 IP</div>
          <div className="text-foreground mt-0.5 font-mono">{task.lastIp || "—"}</div>
        </div>
        <div>
          <div className="text-muted-foreground">已更新 IP</div>
          <div className="text-foreground mt-0.5 font-mono">{task.lastUpdatedIp || "—"}</div>
        </div>
        <div className="col-span-2 md:col-span-1">
          <div className="text-muted-foreground">状态</div>
          <div className="text-foreground mt-0.5 truncate" title={task.lastMessage || ""}>
            {task.lastMessage || "—"}
          </div>
        </div>
      </div>
    </div>
  );
}

function TaskEditDialog({
  task,
  user,
  onClose,
  onSaved,
}: {
  task: DdnsTask;
  user?: StoredUser | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<DdnsTask>(task);
  const [domains, setDomains] = useState<ChmlfrpAvailableDomain[]>([]);
  const [interfaces, setInterfaces] = useState<NetworkInterface[]>([]);
  const [credentials, setCredentials] = useState<DnsCredential[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    ddnsService.listAvailableDomains().then(setDomains).catch(() => {});
    ddnsService.listInterfaces().then(setInterfaces).catch(() => {});
    if (user?.username) {
      ddnsService.listDnsCredentials(user.username).then(setCredentials).catch(() => {});
    }
  }, [user?.username]);

  const update = (patch: Partial<DdnsTask>) => setForm({ ...form, ...patch });

  const updateCredentialSource = (source: CredentialSource) => {
    // 切换凭证来源时，ChmlFrp 仅支持 A 记录且域名从可用列表选
    if (source.type === "chmlfrp") {
      update({ credentialSource: source, recordType: "A", domain: "" });
    } else {
      update({ credentialSource: source, domain: "" });
    }
  };

  const updateSchedule = (patch: Partial<ScheduleMode>) => {
    if (form.schedule.type === "scheduled" && patch.type !== "intervals") {
      update({ schedule: { ...form.schedule, ...patch } as ScheduleMode });
    } else if (form.schedule.type === "intervals" && patch.type !== "scheduled") {
      update({ schedule: { ...form.schedule, ...patch } as ScheduleMode });
    } else {
      // 切换类型
      if (patch.type === "scheduled") {
        update({ schedule: { type: "scheduled", times: ["08:00"] } });
      } else {
        update({
          schedule: {
            type: "intervals",
            intervals: [createEmptyInterval()],
            fallbackIntervalSecs: 300,
          },
        });
      }
    }
  };

  const handleSave = async () => {
    if (!user?.username) return;
    if (!form.name.trim()) {
      toast.error("请填写任务名称");
      return;
    }
    if (form.credentialSource.type === "credential" && !form.credentialSource.credentialId) {
      toast.error("请选择 DNS 凭证");
      return;
    }
    if (!form.domain) {
      toast.error("请选择主域名");
      return;
    }
    if (!form.record.trim()) {
      toast.error("请填写子域名前缀");
      return;
    }
    if (form.schedule.type === "scheduled" && form.schedule.times.length === 0) {
      toast.error("请至少添加一个触发时间点");
      return;
    }
    if (form.schedule.type === "intervals" && form.schedule.fallbackIntervalSecs < 60) {
      toast.error("默认间隔不能小于 60 秒");
      return;
    }
    setSaving(true);
    try {
      const payload = { ...form, id: form.id || `t_${Date.now().toString(36)}` };
      await ddnsService.saveTask(user.username, payload);
      toast.success("已保存");
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto visible-scrollbar">
        <DialogHeader>
          <DialogTitle>{task.id ? "编辑 DDNS 任务" : "新建 DDNS 任务"}</DialogTitle>
          <DialogDescription>
            监控本机网卡 IP，变化时自动更新 DNS 解析（支持 A/AAAA 记录）
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          <div className="space-y-1.5">
            <Label>任务名称</Label>
            <Input
              value={form.name}
              onChange={(e) => update({ name: e.target.value })}
              placeholder="例如：家庭宽带 DDNS"
            />
          </div>

          {/* 凭证来源选择 */}
          <div className="space-y-1.5">
            <Label>DNS 服务商</Label>
            <Select
              options={[
                { value: "__chmlfrp__", label: "ChmlFrp 免费域名（当前登录账户）" },
                ...credentials.map((c) => ({
                  value: c.id,
                  label: `${c.name}（${dnsFailoverService.providerLabel(c.provider)}）`,
                })),
              ]}
              value={
                form.credentialSource.type === "chmlfrp"
                  ? "__chmlfrp__"
                  : form.credentialSource.credentialId
              }
              onChange={(v) => {
                const val = String(v);
                if (val === "__chmlfrp__") {
                  updateCredentialSource({ type: "chmlfrp" });
                } else {
                  updateCredentialSource({ type: "credential", credentialId: val });
                }
              }}
              placeholder="选择 DNS 服务商"
            />
            {form.credentialSource.type === "credential" && credentials.length === 0 && (
              <p className="text-xs text-muted-foreground">
                暂无 DNS 凭证，请在「DNS 服务商」页面创建
              </p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>主域名</Label>
              {form.credentialSource.type === "chmlfrp" ? (
                <Select
                  options={domains.map((d) => ({
                    value: d.domain,
                    label: d.domain + (d.icpFiling ? "（已备案）" : ""),
                  }))}
                  value={form.domain}
                  onChange={(v) => update({ domain: String(v) })}
                  placeholder="选择主域名"
                />
              ) : (
                <Input
                  value={form.domain}
                  onChange={(e) => update({ domain: e.target.value })}
                  placeholder="例如 example.com"
                />
              )}
            </div>
            <div className="space-y-1.5">
              <Label>子域名前缀</Label>
              <Input
                value={form.record}
                onChange={(e) => update({ record: e.target.value })}
                placeholder="例如 www"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>记录类型</Label>
              <Select
                options={
                  form.credentialSource.type === "chmlfrp"
                    ? [{ value: "A", label: "A（IPv4）" }]
                    : [
                        { value: "A", label: "A（IPv4）" },
                        { value: "AAAA", label: "AAAA（IPv6）" },
                      ]
                }
                value={form.recordType}
                onChange={(v) => update({ recordType: String(v) })}
              />
            </div>
            <div className="space-y-1.5">
              <Label>监听网卡</Label>
              <Select
                options={[
                  { value: "", label: "自动选择" },
                  ...interfaces.map((iface) => ({
                    value: iface.name,
                    label: `${iface.name} (${iface.ip})${iface.isIpv6 ? " [IPv6]" : ""}`,
                  })),
                ]}
                value={form.interface}
                onChange={(v) => update({ interface: String(v) })}
              />
            </div>
          </div>

          {/* 调度模式 */}
          <div className="space-y-1.5">
            <Label>调度模式</Label>
            <div className="flex gap-2">
              <Button
                variant={form.schedule.type === "intervals" ? "default" : "outline"}
                size="sm"
                onClick={() => updateSchedule({ type: "intervals" })}
              >
                分时段间隔
              </Button>
              <Button
                variant={form.schedule.type === "scheduled" ? "default" : "outline"}
                size="sm"
                onClick={() => updateSchedule({ type: "scheduled" })}
              >
                定时触发
              </Button>
            </div>
          </div>

          {form.schedule.type === "scheduled" && (
            <ScheduledEditor
              times={form.schedule.times}
              onChange={(times) => update({ schedule: { type: "scheduled", times } })}
            />
          )}

          {form.schedule.type === "intervals" && (
            <IntervalsEditor
              intervals={form.schedule.intervals}
              fallback={form.schedule.fallbackIntervalSecs}
              onChange={(intervals, fallback) =>
                update({ schedule: { type: "intervals", intervals, fallbackIntervalSecs: fallback } })
              }
            />
          )}

          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => update({ enabled: e.target.checked })}
              className="rounded"
            />
            启用任务
          </label>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ScheduledEditor({ times, onChange }: { times: string[]; onChange: (t: string[]) => void }) {
  return (
    <div className="space-y-2 p-3 rounded-lg border border-border/50 bg-muted/30">
      <div className="text-xs text-muted-foreground">每天固定时间点触发（HH:mm）</div>
      {times.map((t, i) => (
        <div key={i} className="flex items-center gap-2">
          <Input
            type="time"
            value={t}
            onChange={(e) => {
              const next = [...times];
              next[i] = e.target.value;
              onChange(next);
            }}
            className="flex-1"
          />
          <Button variant="ghost" size="sm" onClick={() => onChange(times.filter((_, idx) => idx !== i))}>
            <Trash2 className="w-3.5 h-3.5 text-destructive" />
          </Button>
        </div>
      ))}
      <Button variant="outline" size="sm" onClick={() => onChange([...times, "12:00"])}>
        <Plus className="w-3 h-3 mr-1" />
        添加时间点
      </Button>
    </div>
  );
}

function IntervalsEditor({
  intervals,
  fallback,
  onChange,
}: {
  intervals: TimeInterval[];
  fallback: number;
  onChange: (intervals: TimeInterval[], fallback: number) => void;
}) {
  const updateInterval = (i: number, patch: Partial<TimeInterval>) => {
    const next = [...intervals];
    next[i] = { ...next[i], ...patch };
    onChange(next, fallback);
  };

  return (
    <div className="space-y-2 p-3 rounded-lg border border-border/50 bg-muted/30">
      <div className="text-xs text-muted-foreground">
        按时间段设置不同检查频率，未匹配时段使用兜底间隔
      </div>
      {intervals.map((iv, i) => (
        <div key={i} className="grid grid-cols-[1fr_1fr_1fr_auto] gap-2 items-center">
          <Input
            type="time"
            value={iv.start}
            onChange={(e) => updateInterval(i, { start: e.target.value })}
          />
          <Input
            type="time"
            value={iv.end}
            onChange={(e) => updateInterval(i, { end: e.target.value })}
          />
          <Select
            size="sm"
            options={INTERVAL_PRESETS.map((p) => ({ value: p.value, label: p.label }))}
            value={iv.intervalSecs}
            onChange={(v) => updateInterval(i, { intervalSecs: Number(v) })}
          />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onChange(intervals.filter((_, idx) => idx !== i), fallback)}
          >
            <Trash2 className="w-3.5 h-3.5 text-destructive" />
          </Button>
        </div>
      ))}
      <div className="flex items-center justify-between">
        <Button
          variant="outline"
          size="sm"
          onClick={() => onChange([...intervals, createEmptyInterval()], fallback)}
        >
          <Plus className="w-3 h-3 mr-1" />
          添加时段
        </Button>
        <div className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">兜底间隔：</span>
          <Select
            size="sm"
            options={INTERVAL_PRESETS.map((p) => ({ value: p.value, label: p.label }))}
            value={fallback}
            onChange={(v) => onChange(intervals, Number(v))}
          />
        </div>
      </div>
    </div>
  );
}

// ===== 日志 Tab =====

function LogsTab({ user, isLoggedIn }: { user?: StoredUser | null; isLoggedIn: boolean }) {
  const confirm = useConfirm();
  const [logs, setLogs] = useState<DdnsLog[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!user?.username) {
      setLogs([]);
      return;
    }
    setLoading(true);
    try {
      setLogs(await ddnsService.listLogs(user.username));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "加载日志失败");
    } finally {
      setLoading(false);
    }
  }, [user?.username]);

  useEffect(() => {
    load();
  }, [load]);

  // 监听任务事件刷新日志
  useEffect(() => {
    const unlisten = listen<{ refresh: boolean }>("ddns-task-event", () => {
      load();
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [load]);

  const handleClear = async () => {
    if (!user?.username) return;
    const ok = await confirm({
      title: "清空日志",
      description: "确认清空所有 DDNS 日志？此操作不可恢复。",
      confirmText: "清空",
      variant: "destructive",
    });
    if (!ok) return;
    try {
      await ddnsService.clearLogs(user.username);
      toast.success("已清空");
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "清空失败");
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-foreground">更新日志</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            记录每次 DDNS 检查和 IP 更新事件（最多 500 条）
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={handleClear} disabled={!isLoggedIn || logs.length === 0}>
          <Trash className="w-3.5 h-3.5 mr-1.5" />
          清空
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12 text-muted-foreground">
          <Loader2 className="w-5 h-5 animate-spin mr-2" />
          加载中...
        </div>
      ) : logs.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
          <Clock className="w-10 h-10 mb-3 opacity-40" />
          <p className="text-sm">暂无日志</p>
        </div>
      ) : (
        <div className="space-y-2">
          {logs.map((log, i) => (
            <LogEntry key={i} log={log} />
          ))}
        </div>
      )}
    </div>
  );
}

function LogEntry({ log }: { log: DdnsLog }) {
  const icon =
    log.action === "update" ? (
      <RefreshCw className="w-3.5 h-3.5 text-blue-500" />
    ) : log.action === "error" ? (
      <AlertTriangle className="w-3.5 h-3.5 text-destructive" />
    ) : (
      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
    );

  return (
    <div className="flex items-start gap-2 p-3 rounded-lg border border-border/40 bg-card">
      <div className="mt-0.5">{icon}</div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 text-xs">
          <span className="font-medium text-foreground">{log.taskName}</span>
          <span className="text-muted-foreground">
            {new Date(log.time).toLocaleString("zh-CN")}
          </span>
        </div>
        <div className="text-xs text-muted-foreground mt-0.5">{log.message}</div>
      </div>
    </div>
  );
}
