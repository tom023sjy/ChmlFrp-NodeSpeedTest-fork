import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

// ===== 类型定义（与后端 Rust 结构体对应，使用 camelCase）=====

export type DnsProviderKind = "dnspodCn" | "dnspodCom" | "aliyun" | "cloudflare";

/**
 * ChmlFrp 免费域名凭证的特殊标识。
 * 当任务 credentialId 等于此值时，后端调度器会自动用当前登录用户的 accessToken
 * 构造临时 ChmlFrp 凭证，无需在凭证列表中手动创建。
 */
export const CHMLFRP_CREDENTIAL_ID = "__chmlfrp__";

export interface DnsCredential {
  id: string;
  name: string;
  provider: DnsProviderKind;
  /** DNSPod.cn: SecretId；Aliyun: AccessKeyId */
  secretId?: string;
  /** DNSPod.cn: SecretKey；Aliyun: AccessKeySecret */
  secretKey?: string;
  /** DNSPod.com: 格式 "ID,Token" */
  token?: string;
  tokenId?: string;
  /** Cloudflare: API Token */
  apiToken?: string;
  /** 凭证所属用户名（账号隔离用，由后端自动设置） */
  ownerUsername?: string;
}

export interface TunnelTarget {
  id?: string;
  tunnelName: string;
  cnameValue: string;
  nodeHost?: string;
  nodePort?: number;
  note?: string;
}

export type DnsExecutionTarget =
  | { type: "cloud"; id: "xian-cloud" }
  | { type: "device"; id: string };

export interface DnsMonitorTask {
  id: string;
  name: string;
  enabled: boolean;
  /** 用户 token（前端自动填入当前登录账户的 usertoken，不需用户手动输入） */
  userToken: string;
  /** DNS 凭证 ID */
  credentialId: string;
  /** 主域名（如 example.com） */
  domain: string;
  /** 子域名前缀（如 www） */
  subdomain: string;
  /** 主隧道 */
  primaryTunnel: TunnelTarget;
  /** 备用隧道列表（按优先级排序） */
  backupTunnels: TunnelTarget[];
  /** 主隧道连续失败多少次后自动切换（默认 2） */
  failThreshold: number;
  /** 主隧道恢复连续多少次后自动回切（默认 2） */
  recoverThreshold: number;
  /** 轮询间隔（秒），默认 60，范围 10-3600 */
  pollIntervalSecs: number;
  /** 启用的检测方式列表，可选值："tunnel_state" / "node_state" / "tcping" */
  checkMethods: string[];
  /** 多少种检测方式不通过时判定主隧道异常（1 到 checkMethods.length） */
  failMethodThreshold: number;
  /** tcping 检测超时时间（秒），范围 1-10 */
  tcpingTimeoutSecs: number;
  /** 任务所属用户名（账号隔离用，由后端自动设置） */
  ownerUsername?: string;
  executionTarget?: DnsExecutionTarget;
  revision?: number;
  runtimeStatus?: string;
  executorOnline?: boolean;
  lastSyncAt?: string;
}

export interface TaskRuntime {
  primaryFailCount: number;
  primarySuccessCount: number;
  activeTunnelName: string;
  failedOver: boolean;
  lastCheck: string;
  lastResult: string;
  /** 下次应检查的 unix 时间戳（0 表示立即检查） */
  nextCheckAt: number;
  status?: string;
  executorOnline?: boolean;
  lastSyncAt?: string;
}

export interface DnsSwitchLog {
  id: string;
  taskId: string;
  taskName: string;
  /** failover | recover */
  kind: string;
  fromTunnel: string;
  toTunnel: string;
  cnameValue: string;
  success: boolean;
  message: string;
  time: string;
  /** 日志所属用户名（账号隔离用） */
  ownerUsername?: string;
}

export interface DnsMonitorEvent {
  taskId: string;
  runtime: TaskRuntime;
}

// ===== 服务类 =====

export class DnsFailoverService {
  // ===== 凭证管理 =====
  async listCredentials(username: string): Promise<DnsCredential[]> {
    return invoke<DnsCredential[]>("list_dns_credentials", { username });
  }

  async saveCredential(username: string, credential: DnsCredential): Promise<DnsCredential> {
    return invoke<DnsCredential>("save_dns_credential", { username, credential });
  }

  async deleteCredential(username: string, id: string): Promise<void> {
    await invoke("delete_dns_credential", { username, id });
  }

  /** 验证凭证有效性（保存前调用，失败抛出带服务商标识的错误） */
  async verifyCredential(credential: DnsCredential): Promise<void> {
    await invoke<void>("dns_verify_credential", { credential });
  }

  // ===== 任务管理 =====
  async listTasks(username: string): Promise<DnsMonitorTask[]> {
    return invoke<DnsMonitorTask[]>("list_dns_tasks", { username });
  }

  async saveTask(username: string, task: DnsMonitorTask): Promise<DnsMonitorTask> {
    return invoke<DnsMonitorTask>("save_dns_task", { username, task });
  }

  async deleteTask(username: string, id: string): Promise<void> {
    await invoke("delete_dns_task", { username, id });
  }

  // ===== 运行时状态 =====
  async listRuntime(username: string): Promise<Record<string, TaskRuntime>> {
    return invoke<Record<string, TaskRuntime>>("list_dns_runtime", { username });
  }

  /** 手动触发一次检查（不等下一个 60s 周期） */
  async triggerCheck(): Promise<void> {
    await invoke("trigger_dns_check");
  }

  /** 手动检查单个任务 */
  async triggerCheckTask(taskId: string): Promise<void> {
    await invoke("trigger_dns_check_task", { taskId });
  }

  // ===== 日志 =====
  async listLogs(username: string): Promise<DnsSwitchLog[]> {
    return invoke<DnsSwitchLog[]>("list_dns_logs", { username });
  }

  async clearLogs(username: string): Promise<void> {
    await invoke("clear_dns_logs", { username });
  }

  // ===== 事件监听 =====
  /** 监听后端推送的 dns-monitor-event */
  onMonitorEvent(callback: (event: DnsMonitorEvent) => void): Promise<UnlistenFn> {
    return listen<DnsMonitorEvent>("dns-monitor-event", (e) => {
      callback(e.payload);
    });
  }

  // ===== 工具方法 =====
  /** 生成简易 ID（前端临时使用，后端会再生成） */
  genId(): string {
    return Date.now().toString(16) + Math.random().toString(16).slice(2, 8);
  }

  /** 服务商显示名 */
  providerLabel(kind: DnsProviderKind): string {
    switch (kind) {
      case "dnspodCn":
        return "DNSPod.cn（腾讯云）";
      case "dnspodCom":
        return "DNSPod.com（国际）";
      case "aliyun":
        return "Aliyun（阿里云）";
      case "cloudflare":
        return "Cloudflare";
    }
  }

  // ===== TXT 记录清理 =====

  /** 列出所有凭证（含 ChmlFrp 免费域名）下的全部 TXT 记录 */
  async listAllTxtRecords(username: string): Promise<TxtRecordItem[]> {
    return invoke<TxtRecordItem[]>("dns_list_all_txt_records", { username });
  }

  /** 删除指定的 TXT 记录 */
  async deleteTxtRecord(
    username: string,
    credentialId: string,
    domain: string,
    recordId: string,
  ): Promise<void> {
    return invoke<void>("dns_delete_txt_record", {
      username,
      credentialId,
      domain,
      recordId,
    });
  }
}

/** TXT 记录条目（用于清理界面展示与删除） */
export interface TxtRecordItem {
  credentialId: string;
  credentialLabel: string;
  domain: string;
  recordId: string;
  name: string;
  value: string;
}

export const dnsFailoverService = new DnsFailoverService();
