import { invoke } from "@tauri-apps/api/core";

// ===== 类型定义（与后端 Rust 结构体对应，使用 camelCase）=====

/** ChmlFrp 可用主域名 */
export interface ChmlfrpAvailableDomain {
  id: number;
  domain: string;
  remarks: string;
  icpFiling: boolean;
  state: string;
}

/** 调度模式：定时检查 / 分时段间隔 */
export type ScheduleMode =
  | { type: "scheduled"; times: string[] }
  | {
      type: "intervals";
      intervals: TimeInterval[];
      fallbackIntervalSecs: number;
    };

/** 时间段配置 */
export interface TimeInterval {
  start: string;
  end: string;
  intervalSecs: number;
}

/** 凭证来源：ChmlFrp accessToken 或引用 DNS 凭证 ID */
export type CredentialSource =
  | { type: "chmlfrp" }
  | { type: "credential"; credentialId: string };

/** DDNS 动态解析任务 */
export interface DdnsTask {
  id: string;
  name: string;
  domain: string;
  record: string;
  recordType: string;
  credentialSource: CredentialSource;
  interface: string;
  schedule: ScheduleMode;
  enabled: boolean;
  lastCheck?: string | null;
  lastIp?: string | null;
  lastUpdatedIp?: string | null;
  lastMessage?: string | null;
  ownerUsername?: string;
}

/** DDNS 操作日志 */
export interface DdnsLog {
  time: string;
  taskId: string;
  taskName: string;
  action: "check" | "update" | "error";
  detectedIp?: string | null;
  previousIp?: string | null;
  updatedIp?: string | null;
  message: string;
  ownerUsername?: string;
}

/** 本机网卡信息 */
export interface NetworkInterface {
  name: string;
  ip: string;
  isIpv6: boolean;
}

/** DNS 凭证（从 DNS 容灾模块引用） */
export interface DnsCredential {
  id: string;
  name: string;
  provider: string;
  secretId?: string;
  secretKey?: string;
  token?: string;
  apiToken?: string;
  ownerUsername?: string;
}

// ===== 服务类 =====

export class DdnsService {
  /** 获取 ChmlFrp 可用的主域名列表（无需鉴权） */
  async listAvailableDomains(): Promise<ChmlfrpAvailableDomain[]> {
    return invoke<ChmlfrpAvailableDomain[]>("ddns_list_available_domains");
  }

  /** 获取本机所有非回环网卡（IPv4 + IPv6） */
  async listInterfaces(): Promise<NetworkInterface[]> {
    return invoke<NetworkInterface[]>("ddns_list_interfaces");
  }

  /** 获取 DNS 凭证列表（从 DNS 容灾模块引用） */
  async listDnsCredentials(username: string): Promise<DnsCredential[]> {
    return invoke<DnsCredential[]>("list_dns_credentials", { username });
  }

  // ===== 任务管理 =====

  async listTasks(username: string): Promise<DdnsTask[]> {
    return invoke<DdnsTask[]>("list_ddns_tasks", { username });
  }

  async saveTask(username: string, task: DdnsTask): Promise<DdnsTask> {
    return invoke<DdnsTask>("save_ddns_task", { username, task });
  }

  async deleteTask(username: string, id: string): Promise<void> {
    await invoke("delete_ddns_task", { username, id });
  }

  // ===== 日志 =====

  async listLogs(username: string): Promise<DdnsLog[]> {
    return invoke<DdnsLog[]>("list_ddns_logs", { username });
  }

  async clearLogs(username: string): Promise<void> {
    await invoke("clear_ddns_logs", { username });
  }
}

export const ddnsService = new DdnsService();
