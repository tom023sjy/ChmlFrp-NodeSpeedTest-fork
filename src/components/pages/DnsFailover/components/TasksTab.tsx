import { useState, useEffect, useCallback, useRef } from "react";
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
  Cloud,
  Monitor,
} from "lucide-react";
import { toast } from "sonner";
import { type StoredUser, fetchTunnels, type Tunnel } from "@/services/api";
import { useConfirm } from "@/components/ui/confirm-dialog";
import {
  dnsFailoverService,
  CHMLFRP_CREDENTIAL_ID,
  type DnsMonitorTask,
  type DnsCredential,
  type TunnelTarget,
  type TaskRuntime,
  type DnsMonitorEvent,
} from "@/services/dnsFailoverService";
import { ddnsService, type ChmlfrpAvailableDomain } from "@/services/ddnsService";
import { TunnelSelect } from "./TunnelSelect";
import { useEffectType, getCardClassName } from "@/lib/useEffectType";
import { reportUsage } from "@/services/backendApi";
import {
  dnsFailoverCloudService,
  type ExecutionTargetInfo,
} from "@/services/dnsFailoverCloudService";
import { getDeviceId } from "@/services/deviceId";
import { migrateDnsFailoverToCloud } from "@/services/dnsFailoverMigration";
import { getRelayClient } from "@/services/deviceRelay";
import {
  isDnsFailoverSnapshotEqual,
  readDnsFailoverSnapshot,
  writeDnsFailoverSnapshot,
  type DnsFailoverSnapshot,
} from "@/services/dnsFailoverCache";

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
  executionTarget: { type: "cloud", id: "xian-cloud" },
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
  const confirm = useConfirm();
  const initialSnapshot = user?.username ? readDnsFailoverSnapshot(user.username) : null;
  const snapshotRef = useRef<DnsFailoverSnapshot | null>(initialSnapshot);
  const [list, setList] = useState<DnsMonitorTask[]>(initialSnapshot?.tasks ?? []);
  const [credentials, setCredentials] = useState<DnsCredential[]>(initialSnapshot?.credentials ?? []);
  const [runtime, setRuntime] = useState<Record<string, TaskRuntime>>(initialSnapshot?.runtime ?? {});
  const [tunnels, setTunnels] = useState<Tunnel[]>([]);
  const [tunnelsLoading, setTunnelsLoading] = useState(false);
  const [chmlfrpDomains, setChmlfrpDomains] = useState<ChmlfrpAvailableDomain[]>([]);
  const [chmlfrpDomainsLoading, setChmlfrpDomainsLoading] = useState(false);
  const [loading, setLoading] = useState(!initialSnapshot);
  const [editing, setEditing] = useState<DnsMonitorTask | null>(null);
  const [checkingTaskIds, setCheckingTaskIds] = useState<Set<string>>(new Set());
  const [executionTargets, setExecutionTargets] = useState<ExecutionTargetInfo[]>(initialSnapshot?.executionTargets ?? []);
  const [cloudMode, setCloudMode] = useState(!!initialSnapshot);
  const [syncWarning, setSyncWarning] = useState<string | null>(null);
  const [localDeviceId, setLocalDeviceId] = useState<string | null>(null);
  const effectType = useEffectType();

  const applySnapshot = useCallback((snapshot: DnsFailoverSnapshot) => {
    setList(snapshot.tasks);
    setCredentials(snapshot.credentials);
    setExecutionTargets(snapshot.executionTargets);
    setRuntime(snapshot.runtime);
    snapshotRef.current = snapshot;
  }, []);

  const load = useCallback(async () => {
    if (!user?.username) {
      setLoading(false);
      setList([]);
      setCredentials([]);
      setRuntime({});
      return;
    }
    const cached = readDnsFailoverSnapshot(user.username);
    if (cached) {
      applySnapshot(cached);
      setCloudMode(true);
      setLoading(false);
    } else {
      setList([]);
      setCredentials([]);
      setExecutionTargets([]);
      setRuntime({});
      snapshotRef.current = null;
      setLoading(true);
    }
    try {
      try {
        await migrateDnsFailoverToCloud(user);
        const [tasks, creds, targets] = await Promise.all([
          dnsFailoverCloudService.listTasks(),
          dnsFailoverCloudService.listCredentials(),
          dnsFailoverCloudService.listExecutionTargets(),
        ]);
        const nextSnapshot: DnsFailoverSnapshot = {
          tasks,
          credentials: creds,
          executionTargets: targets,
          runtime: Object.fromEntries(tasks.map((task) => [task.id, {
          primaryFailCount: 0,
          primarySuccessCount: 0,
          activeTunnelName: task.primaryTunnel.tunnelName,
          failedOver: false,
          lastCheck: task.lastSyncAt ?? "",
          lastResult: task.runtimeStatus ?? "",
          nextCheckAt: 0,
          status: task.runtimeStatus,
          executorOnline: task.executorOnline,
          lastSyncAt: task.lastSyncAt,
          }])),
          updatedAt: new Date().toISOString(),
        };
        if (!snapshotRef.current || !isDnsFailoverSnapshotEqual(snapshotRef.current, nextSnapshot)) {
          applySnapshot(nextSnapshot);
          writeDnsFailoverSnapshot(user.username, nextSnapshot);
        }
        setCloudMode(true);
        setSyncWarning(null);
      } catch (cloudError) {
        if (cached) {
          setCloudMode(true);
          setSyncWarning(cloudError instanceof Error ? cloudError.message : "云端同步暂不可用");
          return;
        }
        const [tasks, creds, rt, deviceId] = await Promise.all([
          dnsFailoverService.listTasks(user.username),
          dnsFailoverService.listCredentials(user.username),
          dnsFailoverService.listRuntime(user.username),
          getDeviceId(),
        ]);
        setList(tasks.map((task) => ({
          ...task,
          executionTarget: task.executionTarget ?? { type: "device", id: deviceId },
        })));
        setCredentials(creds);
        setRuntime(rt);
        setExecutionTargets([]);
        setLocalDeviceId(deviceId);
        setCloudMode(false);
        setSyncWarning(cloudError instanceof Error ? cloudError.message : "云端同步暂不可用");
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, [applySnapshot, user?.username]);

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

  // 仅在打开对话框且选择 ChmlFrp 凭证时加载可用主域名列表
  const ensureChmlfrpDomainsLoaded = useCallback(async () => {
    if (chmlfrpDomains.length > 0 || chmlfrpDomainsLoading) return;
    setChmlfrpDomainsLoading(true);
    try {
      const domains = await ddnsService.listAvailableDomains();
      setChmlfrpDomains(domains);
    } catch (e) {
      toast.error(
        e instanceof Error ? e.message : "获取 ChmlFrp 可用域名列表失败",
      );
    } finally {
      setChmlfrpDomainsLoading(false);
    }
  }, [chmlfrpDomains.length, chmlfrpDomainsLoading]);

  useEffect(() => {
    load();
    let unlisten: (() => void) | undefined;
    dnsFailoverService
      .onMonitorEvent((event: DnsMonitorEvent) => {
        setRuntime((prev) => ({ ...prev, [event.taskId]: event.runtime }));
      })
      .then((fn) => (unlisten = fn))
      .catch(() => {});
    const relay = getRelayClient();
    const unlistenRelay = relay.onDnsMonitorEvent((event) => {
      if (event.runtimeStatus || event.lastCheckAt) {
        setList((prev) => prev.map((task) => task.id === event.taskId
          ? { ...task, runtimeStatus: event.runtimeStatus ?? task.runtimeStatus, lastSyncAt: event.lastCheckAt ?? task.lastSyncAt }
          : task));
      }
    });
    return () => {
      unlisten?.();
      unlistenRelay();
    };
  }, [load]);

  const handleAdd = () => {
    if (!user?.usertoken) {
      toast.error("请先登录账户");
      return;
    }
    // 默认选择 ChmlFrp 免费域名（用当前登录账户），用户也可改为其他 DNS 凭证
    setEditing({
      ...EMPTY_TASK,
      id: dnsFailoverService.genId(),
      credentialId: cloudMode ? (credentials[0]?.id ?? "") : CHMLFRP_CREDENTIAL_ID,
      userToken: user.usertoken,
      executionTarget: cloudMode
        ? { type: "cloud", id: "xian-cloud" }
        : { type: "device", id: localDeviceId ?? "local" },
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
    // 打开对话框时加载隧道列表和 ChmlFrp 可用域名（仅首次加载，已加载则跳过）
    void ensureTunnelsLoaded();
    void ensureChmlfrpDomainsLoaded();
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
    if (editing.backupTunnels.length < 1)
      return toast.error("至少配置一个备用隧道");
    if (!editing.executionTarget) return toast.error("请选择执行位置");
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
      const isNew = !list.some((task) => task.id === editing.id);
      if (cloudMode) {
        if (isNew) {
          await dnsFailoverCloudService.createTask({ ...editing, id: "" });
        } else {
          await dnsFailoverCloudService.saveTask(editing, editing.revision);
        }
      } else {
        await dnsFailoverService.saveTask(user.username, editing);
      }
      toast.success("任务已保存");
      // DNS 容灾任务保存成功埋点：区分新建/编辑
      if (user?.accessToken) {
        reportUsage({ eventType: isNew ? "dns_task_create" : "dns_task_update", eventData: { provider: editing.credentialId ? "configured" : "unknown" } }).catch(() => {});
      }
      setEditing(null);
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "保存失败");
    }
  };

  const handleDelete = async (task: DnsMonitorTask) => {
    const ok = await confirm({
      title: "删除任务",
      description: `确认删除任务「${task.name}」？删除后将停止该任务的监控。`,
      confirmText: "删除",
      variant: "destructive",
    });
    if (!ok) return;
    try {
      if (!user?.username) {
        toast.error("未登录");
        return;
      }
      if (cloudMode) {
        await dnsFailoverCloudService.deleteTask(task.id);
      } else {
        await dnsFailoverService.deleteTask(user.username, task.id);
      }
      toast.success("已删除");
      // DNS 容灾任务删除成功埋点
      if (user?.accessToken) {
        reportUsage({ eventType: "dns_task_delete" }).catch(() => {});
      }
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
      if (cloudMode) {
        if (task.enabled) {
          await dnsFailoverCloudService.disableTask(task.id, task.revision ?? 0);
        } else {
          await dnsFailoverCloudService.enableTask(task.id, task.revision ?? 0);
        }
      } else {
        await dnsFailoverService.saveTask(user.username, { ...task, enabled: !task.enabled });
      }
      // DNS 容灾监控启用/停用埋点：仅在用户已登录时上报，失败静默
      if (user?.accessToken) {
        if (!task.enabled) {
          // 由停用切换为启用：兼容旧事件 dns_monitor + 新事件 dns_monitor_enable
          reportUsage({ eventType: "dns_monitor" }).catch(() => {});
          reportUsage({ eventType: "dns_monitor_enable" }).catch(() => {});
        } else {
          // 由启用切换为停用
          reportUsage({ eventType: "dns_monitor_disable" }).catch(() => {});
        }
      }
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "切换失败");
    }
  };

  // 单任务立即检查
  const handleCheckTask = async (task: DnsMonitorTask) => {
    setCheckingTaskIds((prev) => new Set(prev).add(task.id));
    try {
      if (cloudMode) {
        await dnsFailoverCloudService.checkTask(task.id);
      } else {
        await dnsFailoverService.triggerCheckTask(task.id);
      }
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
    const tunnel = tunnels.find((item) => item.name === tunnelName);
    setEditing({
      ...editing,
      primaryTunnel: {
        ...editing.primaryTunnel,
        id: tunnel ? String(tunnel.id) : editing.primaryTunnel.id,
        tunnelName,
        cnameValue,
        nodeHost: tunnel?.node_ip ?? cnameValue,
        nodePort: tunnel?.remote_port ?? tunnel?.server_port,
      },
    });
  };

  // 备用隧道操作
  const handleBackupSelect = (idx: number, tunnelName: string, cnameValue: string) => {
    if (!editing) return;
    const tunnel = tunnels.find((item) => item.name === tunnelName);
    const backups = editing.backupTunnels.map((b, i) =>
      i === idx
        ? {
            ...b,
            id: tunnel ? String(tunnel.id) : b.id,
            tunnelName,
            cnameValue,
            nodeHost: tunnel?.node_ip ?? cnameValue,
            nodePort: tunnel?.remote_port ?? tunnel?.server_port,
          }
        : b,
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
      {syncWarning && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          云端同步暂不可用，当前使用本机数据：{syncWarning}
        </div>
      )}
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
            const target = executionTargets.find((item) =>
              item.type === task.executionTarget?.type && item.id === task.executionTarget?.id,
            );
            const isCloud = task.executionTarget?.type === "cloud";
            const executorOnline = task.executorOnline ?? target?.online ?? !cloudMode;
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
                    <div className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                      {isCloud ? <Cloud className="h-3 w-3" /> : <Monitor className="h-3 w-3" />}
                      <span>{isCloud ? "云端" : (target?.name ?? "原当前客户端")}</span>
                      <span className={executorOnline ? "text-emerald-500" : "text-amber-500"}>
                        {executorOnline ? "运行中" : "执行端离线，已暂停"}
                      </span>
                      {task.lastSyncAt && <span>同步于 {task.lastSyncAt}</span>}
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

              {/* DNS 服务商 */}
              <div className="space-y-1.5">
                <Label>执行位置</Label>
                <Select
                  options={[
                    ...(cloudMode ? [{ value: "cloud:xian-cloud", label: "云端" }] : []),
                    ...(!cloudMode && localDeviceId ? [{
                      value: `device:${localDeviceId}`,
                      label: "当前客户端 · 本地兼容模式",
                    }] : []),
                    ...executionTargets
                      .filter((target) => target.type === "device" && target.online)
                      .filter((target) => target.capabilities.includes("dns_failover_probe.v1"))
                      .map((target) => ({
                        value: `device:${target.id}`,
                        label: `${target.name} · ${target.deviceType === "daemon" ? "服务主机" : "桌面客户端"}${target.osInfo ? ` · ${target.osInfo}` : ""}`,
                      })),
                    ...(editing.executionTarget?.type === "device" && !executionTargets.some((target) =>
                      target.type === "device" && target.id === editing.executionTarget?.id && target.online,
                    ) ? [{
                      value: `device:${editing.executionTarget.id}`,
                      label: "当前绑定主机（离线，任务将暂停）",
                    }] : []),
                  ]}
                  value={`${editing.executionTarget?.type ?? "cloud"}:${editing.executionTarget?.id ?? "xian-cloud"}`}
                  onChange={(value) => {
                    const [type, id] = String(value).split(":", 2);
                    setEditing({
                      ...editing,
                      executionTarget: type === "cloud"
                        ? { type: "cloud", id: "xian-cloud" }
                        : { type: "device", id },
                    });
                  }}
                />
                <p className="text-[11px] text-muted-foreground">
                  任务只在选定位置执行。指定主机离线时暂停，不会自动转移到其他位置。
                </p>
              </div>

              {/* DNS 服务商 */}
              <div className="space-y-1.5">
                <Label>DNS 服务商</Label>
                <Select
                  options={[
                    {
                      value: CHMLFRP_CREDENTIAL_ID,
                      label: "ChmlFrp 免费域名（当前登录账户）",
                    },
                    ...credentials.map((c) => ({
                      value: c.id,
                      label: `${c.name}（${dnsFailoverService.providerLabel(c.provider)}）`,
                    })),
                  ]}
                  value={editing.credentialId}
                  onChange={(v) => {
                    const newCredId = String(v);
                    // 切换凭证来源时清空主域名，避免不同来源的域名格式不匹配
                    setEditing({
                      ...editing,
                      credentialId: newCredId,
                      domain: "",
                    });
                    // 切换到 ChmlFrp 时确保可用域名列表已加载
                    if (newCredId === CHMLFRP_CREDENTIAL_ID) {
                      void ensureChmlfrpDomainsLoaded();
                    }
                  }}
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>主域名</Label>
                  {editing.credentialId === CHMLFRP_CREDENTIAL_ID ? (
                    <Select
                      options={chmlfrpDomains.map((d) => ({
                        value: d.domain,
                        label: d.domain + (d.icpFiling ? "（已备案）" : ""),
                      }))}
                      value={editing.domain}
                      onChange={(v) =>
                        setEditing({ ...editing, domain: String(v) })
                      }
                      placeholder={
                        chmlfrpDomainsLoading ? "加载中..." : "选择主域名"
                      }
                    />
                  ) : (
                    <Input
                      value={editing.domain}
                      onChange={(e) =>
                        setEditing({ ...editing, domain: e.target.value })
                      }
                      placeholder="example.com"
                    />
                  )}
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
