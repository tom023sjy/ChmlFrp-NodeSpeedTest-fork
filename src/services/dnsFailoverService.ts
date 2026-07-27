import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

// ===== 类型定义（与后端 Rust 结构体对应，使用 camelCase）=====

export type DnsProviderKind = "dnspodCn" | "dnspodCom" | "aliyun" | "cloudflare";

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
  /** Cloudflare: API Token */
  apiToken?: string;
  /** 凭证所属用户名（账号隔离用，由后端自动设置） */
  ownerUsername?: string;
}

export interface TunnelTarget {
  tunnelName: string;
  cnameValue: string;
  note?: string;
}

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
}

export const dnsFailoverService = new DnsFailoverService();
