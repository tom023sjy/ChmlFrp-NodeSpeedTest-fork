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
  ListChecks,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  ArrowRight,
  Settings2,
  RefreshCw,
} from "lucide-react";
import { toast } from "sonner";
import { type StoredUser, fetchTunnels, type Tunnel } from "@/services/api";
import {
  dnsFailoverService,
  type DnsMonitorTask,
  type DnsCredential,
  type TunnelTarget,
  type TaskRuntime,
  type DnsMonitorEvent,
} from "@/services/dnsFailoverService";
import { TunnelSelect } from "./TunnelSelect";
import { useEffectType, getCardClassName } from "@/lib/useEffectType";

interface TasksTabProps {
  user?: StoredUser | null;
}

const EMPTY_TUNNEL: TunnelTarget = { tunnelName: "", cnameValue: "", note: "" };

const EMPTY_TASK: DnsMonitorTask = {
  id: "",
  name: "",
  enabled: true,
  userToken: "",
  credentialId: "",
  domain: "",
  subdomain: "",
  primaryTunnel: { ...EMPTY_TUNNEL },
  backupTunnels: [],
  failThreshold: 2,
  recoverThreshold: 2,
  pollIntervalSecs: 60,
  checkMethods: ["tunnel_state", "node_state"],
  failMethodThreshold: 1,
  tcpingTimeoutSecs: 3,
};

/** 检测方式元数据：标签、说明、优缺点 */
const CHECK_METHOD_META: Record<string, { label: string; desc: string; pros: string; cons: string }> = {
  tunnel_state: {
    label: "隧道状态检测",
    desc: "读取 /tunnel 接口返回的 state 字段",
    pros: "响应快，无需额外网络请求",
    cons: "API 状态更新有延迟，故障发生时不能立即反映",
  },
  node_state: {
    label: "节点状态检测",
    desc: "读取 /tunnel 接口返回的 nodestate 字段",
    pros: "能识别节点级故障（如节点维护、节点宕机）",
    cons: "隧道掉线时节点不一定掉线，可能漏报隧道故障",
  },
  tcping: {
    label: "TCPing 检测",
    desc: "对节点域名:远程端口发起 TCP 连接测试",
    pros: "实测真实可达性，最贴近用户访问体验",
    cons: "容易受到本地网络环境影响，本地网络抖动可能误判",
  },
};

export function TasksTab({ user }: TasksTabProps) {
  const [list, setList] = useState<DnsMonitorTask[]>([]);
  const [credentials, setCredentials] = useState<DnsCredential[]>([]);
  const [runtime, setRuntime] = useState<Record<string, TaskRuntime>>({});
  const [tunnels, setTunnels] = useState<Tunnel[]>([]);
  const [tunnelsLoading, setTunnelsLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<DnsMonitorTask | null>(null);
  const [checkingTaskIds, setCheckingTaskIds] = useState<Set<string>>(new Set());
  const effectType = useEffectType();

  const load = useCallback(async () => {
    if (!user?.username) {
      setLoading(false);
      setList([]);
      setCredentials([]);
      setRuntime({});
      return;
    }
    setLoading(true);
    try {
      const [tasks, creds, rt] = await Promise.all([
        dnsFailoverService.listTasks(user.username),
        dnsFailoverService.listCredentials(user.username),
        dnsFailoverService.listRuntime(user.username),
      ]);
      setList(tasks);
      setCredentials(creds);
      setRuntime(rt);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, [user?.username]);

  // 仅在新建/编辑任务打开对话框时加载隧道列表
  // 避免每次进入 DNS 容灾页面都等待隧道 API 响应
  const ensureTunnelsLoaded = useCallback(async () => {
    if (tunnels.length > 0 || tunnelsLoading) return;
    setTunnelsLoading(true);
    try {
      const tunnelList = await fetchTunnels();
      setTunnels(tunnelList);
    } catch (e) {
      toast.error(
        e instanceof Error ? e.message : "获取隧道列表失败，请检查网络或重新登录",
      );
    } finally {
      setTunnelsLoading(false);
    }
  }, [tunnels.length, tunnelsLoading]);

  useEffect(() => {
    load();
    let unlisten: (() => void) | undefined;
    dnsFailoverService
      .onMonitorEvent((event: DnsMonitorEvent) => {
        setRuntime((prev) => ({ ...prev, [event.taskId]: event.runtime }));
      })
      .then((fn) => (unlisten = fn))
      .catch(() => {});
    return () => unlisten?.();
  }, [load]);

  const handleAdd = () => {
    if (credentials.length === 0) {
      toast.error("请先在「DNS 凭证」Tab 中添加凭证");
      return;
    }
    if (!user?.usertoken) {
      toast.error("请先登录账户");
      return;
    }
    const cred = credentials[0];
    setEditing({
      ...EMPTY_TASK,
      id: dnsFailoverService.genId(),
      credentialId: cred.id,
      userToken: user.usertoken,
    });
    // 打开对话框时加载隧道列表（仅首次加载，已加载则跳过）
    void ensureTunnelsLoaded();
  };

  const handleEdit = (task: DnsMonitorTask) => {
    // 兼容旧任务：补齐新增的检测方式字段
    const checkMethods = task.checkMethods && task.checkMethods.length > 0
      ? task.checkMethods
      : ["tunnel_state", "node_state"];
    const failMethodThreshold = task.failMethodThreshold || 1;
    const tcpingTimeoutSecs = task.tcpingTimeoutSecs || 3;
    setEditing({
      ...task,
      primaryTunnel: { ...task.primaryTunnel },
      backupTunnels: task.backupTunnels.map((b) => ({ ...b })),
      checkMethods,
      failMethodThreshold,
      tcpingTimeoutSecs,
    });
    // 打开对话框时加载隧道列表（仅首次加载，已加载则跳过）
    void ensureTunnelsLoaded();
  };

  const handleSave = async () => {
    if (!editing) return;
    if (!editing.name.trim()) return toast.error("请输入任务名称");
    if (!editing.userToken) return toast.error("缺少用户 Token，请先登录");
    if (!editing.credentialId) return toast.error("请选择 DNS 凭证");
    if (!editing.domain.trim()) return toast.error("请输入主域名");
    if (!editing.subdomain.trim()) return toast.error("请输入子域名前缀");
    if (!editing.primaryTunnel.tunnelName.trim())
      return toast.error("请选择主隧道");
    if (!editing.primaryTunnel.cnameValue.trim())
      return toast.error("主隧道缺少 CNAME 值");
    if (editing.failThreshold < 1) return toast.error("失败切换次数至少为 1");
    if (editing.recoverThreshold < 1) return toast.error("恢复回切次数至少为 1");
    if (editing.pollIntervalSecs < 10) return toast.error("轮询间隔至少为 10 秒");
    if (editing.pollIntervalSecs > 3600) return toast.error("轮询间隔最大为 3600 秒");
    // 检测方式校验
    if (editing.checkMethods.length === 0) {
      return toast.error("至少选择一种检测方式");
    }
    const maxThreshold = editing.checkMethods.length;
    if (editing.failMethodThreshold < 1 || editing.failMethodThreshold > maxThreshold) {
      return toast.error(`不通过阈值应在 1 到 ${maxThreshold} 之间`);
    }
    if (editing.checkMethods.includes("tcping")) {
      if (editing.tcpingTimeoutSecs < 1 || editing.tcpingTimeoutSecs > 10) {
        return toast.error("TCPing 超时时间应在 1-10 秒之间");
      }
    }
    // 校验主隧道不与备用隧道重复
    const backupNames = editing.backupTunnels
      .map((b) => b.tunnelName.trim())
      .filter(Boolean);
    if (backupNames.includes(editing.primaryTunnel.tunnelName.trim())) {
      return toast.error("主隧道不能与备用隧道重复");
    }
    // 校验备用隧道之间不重复
    const uniqueBackupNames = new Set(backupNames);
    if (uniqueBackupNames.size !== backupNames.length) {
      return toast.error("备用隧道之间存在重复");
    }
    try {
      if (!user?.username) {
        toast.error("未登录");
        return;
      }
      await dnsFailoverService.saveTask(user.username, editing);
      toast.success("任务已保存");
      setEditing(null);
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "保存失败");
    }
  };

  const handleDelete = async (task: DnsMonitorTask) => {
    if (!confirm(`确认删除任务「${task.name}」？`)) return;
    try {
      if (!user?.username) {
        toast.error("未登录");
        return;
      }
      await dnsFailoverService.deleteTask(user.username, task.id);
      toast.success("已删除");
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "删除失败");
    }
  };

  const handleToggleEnabled = async (task: DnsMonitorTask) => {
    try {
      if (!user?.username) {
        toast.error("未登录");
        return;
      }
      await dnsFailoverService.saveTask(user.username, { ...task, enabled: !task.enabled });
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "切换失败");
    }
  };

  // 单任务立即检查
  const handleCheckTask = async (task: DnsMonitorTask) => {
    setCheckingTaskIds((prev) => new Set(prev).add(task.id));
    try {
      await dnsFailoverService.triggerCheckTask(task.id);
      toast.success(`任务「${task.name}」检查完成`);
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "检查失败");
    } finally {
      setCheckingTaskIds((prev) => {
        const next = new Set(prev);
        next.delete(task.id);
        return next;
      });
    }
  };

  // 主隧道选择回调
  const handlePrimarySelect = (tunnelName: string, cnameValue: string) => {
    if (!editing) return;
    setEditing({
      ...editing,
      primaryTunnel: { ...editing.primaryTunnel, tunnelName, cnameValue },
    });
  };

  // 备用隧道操作
  const handleBackupSelect = (idx: number, tunnelName: string, cnameValue: string) => {
    if (!editing) return;
    const backups = editing.backupTunnels.map((b, i) =>
      i === idx ? { ...b, tunnelName, cnameValue } : b,
    );
    setEditing({ ...editing, backupTunnels: backups });
  };
  const addBackup = () => {
    if (!editing) return;
    setEditing({
      ...editing,
      backupTunnels: [...editing.backupTunnels, { ...EMPTY_TUNNEL }],
    });
  };
  const removeBackup = (idx: number) => {
    if (!editing) return;
    setEditing({
      ...editing,
      backupTunnels: editing.backupTunnels.filter((_, i) => i !== idx),
    });
  };

  if (loading) return <div className="text-sm text-muted-foreground">加载中...</div>;

  const noTunnels = tunnels.length === 0 && !tunnelsLoading;
  // 登录状态：未登录时禁止新建/编辑任务
  const isLoggedIn = !!user?.username && !!user?.usertoken;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-foreground">监控任务</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            按自定义间隔轮询隧道状态，主隧道连续失败达阈值自动切换备用，恢复达阈值自动回切。
          </p>
        </div>
        <Button
          size="sm"
          onClick={handleAdd}
          disabled={!isLoggedIn}
          className="gap-1.5"
          title={!isLoggedIn ? "请先登录" : undefined}
        >
          <Plus className="w-3.5 h-3.5" />
          新建任务
        </Button>
      </div>

      {!isLoggedIn ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <div className="w-12 h-12 rounded-2xl bg-muted/40 flex items-center justify-center mb-3">
            <ListChecks className="w-6 h-6 text-muted-foreground" />
          </div>
          <p className="text-sm text-muted-foreground">请先登录账户后查看和管理监控任务</p>
        </div>
      ) : list.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <div className="w-12 h-12 rounded-2xl bg-muted/40 flex items-center justify-center mb-3">
            <ListChecks className="w-6 h-6 text-muted-foreground" />
          </div>
          <p className="text-sm text-muted-foreground">暂无任务，点击右上角新建</p>
        </div>
      ) : (
        <div className="grid gap-2">
          {list.map((task) => {
            const rt = runtime[task.id];
            const isFailedOver = rt?.failedOver ?? false;
            const activeTunnel = rt?.activeTunnelName ?? task.primaryTunnel.tunnelName;
            return (
              <div
                key={task.id}
                className={`p-3 rounded-xl border border-border/60 ${getCardClassName(effectType)}`}
              >
                <div className="flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-foreground truncate">
                        {task.name}
                      </span>
                      <button
                        onClick={() => handleToggleEnabled(task)}
                        className={cn(
                          "px-1.5 py-0.5 text-[10px] rounded font-medium transition-colors",
                          task.enabled
                            ? "bg-emerald-500/15 text-emerald-500"
                            : "bg-muted text-muted-foreground",
                        )}
                      >
                        {task.enabled ? "启用" : "已停用"}
                      </button>
                      {isFailedOver && (
                        <Badge variant="destructive" className="text-[10px] h-4 px-1">
                          已切换备用
                        </Badge>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      {task.subdomain}.{task.domain}
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleCheckTask(task)}
                      disabled={checkingTaskIds.has(task.id)}
                      className="h-8 w-8 p-0"
                      title="立即检查"
                    >
                      <RefreshCw className={cn("w-3.5 h-3.5", checkingTaskIds.has(task.id) && "animate-spin")} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleEdit(task)}
                      className="h-8 w-8 p-0"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleDelete(task)}
                      className="h-8 w-8 p-0 text-destructive hover:text-destructive"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </div>

                {/* 运行时状态 */}
                <div className="mt-3 pt-3 border-t border-border/40 grid grid-cols-2 gap-2 text-xs">
                  <div className="flex items-center gap-1.5">
                    {isFailedOver ? (
                      <AlertTriangle className="w-3.5 h-3.5 text-amber-500" />
                    ) : (
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                    )}
                    <span className="text-muted-foreground">当前激活：</span>
                    <span className="font-medium text-foreground truncate">
                      {activeTunnel}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Loader2 className="w-3 h-3 text-muted-foreground" />
                    <span className="text-muted-foreground">上次检查：</span>
                    <span className="text-foreground truncate">
                      {rt?.lastCheck || "—"}
                    </span>
                    <span className="ml-auto px-1 py-0.5 rounded bg-muted/60 text-muted-foreground text-[10px]">
                      每 {task.pollIntervalSecs}s
                    </span>
                  </div>
                  <div className="col-span-2 flex items-center gap-1.5">
                    <span className="text-muted-foreground">结果：</span>
                    <span className="text-foreground">{rt?.lastResult || "—"}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* 编辑对话框 */}
      <Dialog open={!!editing} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto visible-scrollbar">
          <DialogHeader>
            <DialogTitle>
              {list.find((t) => t.id === editing?.id) ? "编辑任务" : "新建任务"}
            </DialogTitle>
            <DialogDescription>
              配置 DNS 容灾监控任务的域名、隧道与切换策略
            </DialogDescription>
          </DialogHeader>
          {editing && (
            <div className="space-y-3 py-2">
              {/* 基本信息 */}
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>任务名称</Label>
                  <Input
                    value={editing.name}
                    onChange={(e) =>
                      setEditing({ ...editing, name: e.target.value })
                    }
                    placeholder="如：主站容灾"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>启用</Label>
                  <Select
                    options={[
                      { value: "true", label: "启用" },
                      { value: "false", label: "停用" },
                    ]}
                    value={String(editing.enabled)}
                    onChange={(v) =>
                      setEditing({ ...editing, enabled: v === "true" })
                    }
                  />
                </div>
              </div>

              {/* DNS 凭证 */}
              <div className="space-y-1.5">
                <Label>DNS 凭证</Label>
                <Select
                  options={credentials.map((c) => ({
                    value: c.id,
                    label: `${c.name}（${dnsFailoverService.providerLabel(c.provider)}）`,
                  }))}
                  value={editing.credentialId}
                  onChange={(v) =>
                    setEditing({ ...editing, credentialId: String(v) })
                  }
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>主域名</Label>
                  <Input
                    value={editing.domain}
                    onChange={(e) =>
                      setEditing({ ...editing, domain: e.target.value })
                    }
                    placeholder="example.com"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>子域名前缀</Label>
                  <Input
                    value={editing.subdomain}
                    onChange={(e) =>
                      setEditing({ ...editing, subdomain: e.target.value })
                    }
                    placeholder="www"
                  />
                </div>
              </div>

              {/* 主隧道 */}
              <div className="p-3 rounded-xl border border-primary/30 bg-primary/5">
                <div className="flex items-center gap-2 mb-2">
                  <span className="w-2 h-2 rounded-full bg-primary" />
                  <span className="text-xs font-semibold text-primary">
                    主隧道（默认激活）
                  </span>
                </div>
                {noTunnels ? (
                  <p className="text-xs text-muted-foreground py-2 text-center bg-muted/30 rounded-lg">
                    暂无隧道数据，请确认已登录账户且网络正常
                  </p>
                ) : tunnelsLoading ? (
                  <p className="text-xs text-muted-foreground py-2 text-center bg-muted/30 rounded-lg flex items-center justify-center gap-1.5">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    正在加载隧道列表...
                  </p>
                ) : (
                  <TunnelSelect
                    tunnels={tunnels}
                    value={editing.primaryTunnel.tunnelName}
                    onChange={handlePrimarySelect}
                    placeholder="搜索并选择主隧道..."
                    excludeNames={editing.backupTunnels
                      .map((b) => b.tunnelName.trim())
                      .filter(Boolean)}
                  />
                )}
              </div>

              {/* 备用隧道列表 */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-foreground">
                    备用隧道（按列表顺序优先切换）
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={addBackup}
                    disabled={noTunnels || tunnelsLoading}
                    className="h-7 gap-1 text-xs"
                  >
                    <Plus className="w-3 h-3" />
                    添加
                  </Button>
                </div>
                {editing.backupTunnels.length === 0 ? (
                  <p className="text-xs text-muted-foreground py-2 text-center bg-muted/30 rounded-lg">
                    暂无备用隧道
                  </p>
                ) : (
                  editing.backupTunnels.map((b, idx) => (
                    <div
                      key={idx}
                      className="flex items-center gap-2 p-2 rounded-lg border border-border/60"
                    >
                      <span className="text-[10px] text-muted-foreground w-4 flex-shrink-0">
                        {idx + 1}
                      </span>
                      <div className="flex-1">
                        <TunnelSelect
                          tunnels={tunnels}
                          value={b.tunnelName}
                          onChange={(name, ip) => handleBackupSelect(idx, name, ip)}
                          placeholder="选择备用隧道..."
                          excludeNames={[
                            editing.primaryTunnel.tunnelName,
                            ...editing.backupTunnels
                              .map((bt, bi) => bi !== idx ? bt.tunnelName.trim() : "")
                              .filter(Boolean),
                          ]}
                        />
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => removeBackup(idx)}
                        className="h-8 w-8 p-0 text-destructive hover:text-destructive flex-shrink-0"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  ))
                )}
              </div>

              {/* 检测方式配置 */}
              <div className="p-3 rounded-xl border border-border/60 bg-muted/20">
                <div className="flex items-center gap-2 mb-3">
                  <Settings2 className="w-3.5 h-3.5 text-muted-foreground" />
                  <span className="text-xs font-semibold text-foreground">
                    检测方式
                  </span>
                  <span className="text-[11px] text-muted-foreground">
                    多选，不通过数 ≥ 阈值即判定异常
                  </span>
                </div>
                <div className="space-y-2">
                  {Object.entries(CHECK_METHOD_META).map(([key, meta]) => {
                    const checked = editing.checkMethods.includes(key);
                    return (
                      <label
                        key={key}
                        className={cn(
                          "flex items-start gap-2 p-2 rounded-lg border cursor-pointer transition-colors",
                          checked
                            ? "border-primary/50 bg-primary/5"
                            : "border-border/40 hover:bg-muted/30",
                        )}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) => {
                            const next = e.target.checked
                              ? [...editing.checkMethods, key]
                              : editing.checkMethods.filter((m) => m !== key);
                            // 自动调整阈值，避免越界
                            const maxT = Math.max(1, next.length);
                            const newThreshold = Math.min(
                              editing.failMethodThreshold,
                              maxT,
                            );
                            setEditing({
                              ...editing,
                              checkMethods: next,
                              failMethodThreshold: newThreshold,
                            });
                          }}
                          className="mt-0.5"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="text-xs font-medium text-foreground">
                            {meta.label}
                          </div>
                          <div className="text-[11px] text-muted-foreground mt-0.5">
                            {meta.desc}
                          </div>
                          <div className="text-[11px] mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
                            <span className="text-emerald-600 dark:text-emerald-400">
                              优点：{meta.pros}
                            </span>
                            <span className="text-rose-600 dark:text-rose-400">
                              缺点：{meta.cons}
                            </span>
                          </div>
                        </div>
                      </label>
                    );
                  })}
                </div>
                <div className="grid grid-cols-2 gap-3 mt-3">
                  <div className="space-y-1.5">
                    <Label>不通过阈值</Label>
                    <Input
                      type="number"
                      min={1}
                      max={Math.max(1, editing.checkMethods.length)}
                      value={editing.failMethodThreshold}
                      onChange={(e) =>
                        setEditing({
                          ...editing,
                          failMethodThreshold: parseInt(e.target.value) || 1,
                        })
                      }
                      onBlur={(e) => {
                        const v = parseInt(e.target.value) || 1;
                        const max = Math.max(1, editing.checkMethods.length);
                        const clamped = Math.min(max, Math.max(1, v));
                        setEditing({ ...editing, failMethodThreshold: clamped });
                      }}
                    />
                    <p className="text-[11px] text-muted-foreground">
                      N 种检测不通过即视为异常（1-{editing.checkMethods.length}）
                    </p>
                  </div>
                  {editing.checkMethods.includes("tcping") && (
                    <div className="space-y-1.5">
                      <Label>TCPing 超时（秒）</Label>
                      <Input
                        type="number"
                        min={1}
                        max={10}
                        value={editing.tcpingTimeoutSecs}
                        onChange={(e) =>
                          setEditing({
                            ...editing,
                            tcpingTimeoutSecs: parseInt(e.target.value) || 3,
                          })
                        }
                        onBlur={(e) => {
                          const v = parseInt(e.target.value) || 3;
                          const clamped = Math.min(10, Math.max(1, v));
                          setEditing({ ...editing, tcpingTimeoutSecs: clamped });
                        }}
                      />
                      <p className="text-[11px] text-muted-foreground">
                        TCP 连接超时时间（1-10）
                      </p>
                    </div>
                  )}
                </div>
              </div>

              {/* 切换阈值配置 */}
              <div className="p-3 rounded-xl border border-border/60 bg-muted/20">
                <div className="flex items-center gap-2 mb-3">
                  <Settings2 className="w-3.5 h-3.5 text-muted-foreground" />
                  <span className="text-xs font-semibold text-foreground">
                    切换策略
                  </span>
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <div className="space-y-1.5">
                    <Label>轮询间隔（秒）</Label>
                    <Input
                      type="number"
                      min={10}
                      max={3600}
                      value={editing.pollIntervalSecs}
                      onChange={(e) =>
                        setEditing({
                          ...editing,
                          pollIntervalSecs: parseInt(e.target.value) || 0,
                        })
                      }
                      onBlur={(e) => {
                        const v = parseInt(e.target.value) || 60;
                        const clamped = Math.min(3600, Math.max(10, v));
                        setEditing({ ...editing, pollIntervalSecs: clamped });
                      }}
                    />
                    <p className="text-[11px] text-muted-foreground">
                      每次检查隧道状态的间隔（10-3600）
                    </p>
                  </div>
                  <div className="space-y-1.5">
                    <Label>失败切换次数</Label>
                    <Input
                      type="number"
                      min={1}
                      max={10}
                      value={editing.failThreshold}
                      onChange={(e) =>
                        setEditing({
                          ...editing,
                          failThreshold: parseInt(e.target.value) || 0,
                        })
                      }
                      onBlur={(e) => {
                        const v = parseInt(e.target.value) || 1;
                        const clamped = Math.min(10, Math.max(1, v));
                        setEditing({ ...editing, failThreshold: clamped });
                      }}
                    />
                    <p className="text-[11px] text-muted-foreground">
                      连续失败此次数后切换
                    </p>
                  </div>
                  <div className="space-y-1.5">
                    <Label>恢复回切次数</Label>
                    <Input
                      type="number"
                      min={1}
                      max={10}
                      value={editing.recoverThreshold}
                      onChange={(e) =>
                        setEditing({
                          ...editing,
                          recoverThreshold: parseInt(e.target.value) || 0,
                        })
                      }
                      onBlur={(e) => {
                        const v = parseInt(e.target.value) || 1;
                        const clamped = Math.min(10, Math.max(1, v));
                        setEditing({ ...editing, recoverThreshold: clamped });
                      }}
                    />
                    <p className="text-[11px] text-muted-foreground">
                      恢复连续此次数后回切
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-1.5 mt-2 text-[11px] text-muted-foreground">
                  <ArrowRight className="w-3 h-3" />
                  切换判定：{editing.checkMethods.length} 种检测中不通过 ≥ {editing.failMethodThreshold} 即视为异常
                </div>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>
              取消
            </Button>
            <Button onClick={handleSave}>保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
