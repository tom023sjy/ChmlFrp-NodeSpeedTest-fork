import { BACKEND_API_BASE_URL } from "@/lib/api-endpoints";
import { getStoredUser } from "@/services/api";
import type {
  DnsCredential,
  DnsExecutionTarget,
  DnsMonitorTask,
  DnsSwitchLog,
  TaskRuntime,
  TunnelTarget,
} from "@/services/dnsFailoverService";

export type ExecutionTarget = DnsExecutionTarget;

export type ExecutionTargetInfo = ExecutionTarget & {
  name: string;
  online: boolean;
  deviceType?: "desktop" | "daemon";
  osInfo?: string;
  capabilities: string[];
};

export interface CloudDnsTask extends DnsMonitorTask {
  executionTarget: ExecutionTarget;
  runtimeStatus?: string;
  executorOnline?: boolean;
  lastSyncAt?: string;
  revision: number;
}

export interface CloudDnsRuntime extends TaskRuntime {
  status?: string;
  executorOnline?: boolean;
  lastSyncAt?: string;
}

type BackendTask = Record<string, unknown>;

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return (value as T) ?? fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function normalizeTunnel(value: unknown): TunnelTarget {
  const tunnel = (value ?? {}) as Record<string, unknown>;
  return {
    id: String(tunnel.id ?? ""),
    tunnelName: String(tunnel.tunnelName ?? tunnel.name ?? ""),
    cnameValue: String(tunnel.cnameValue ?? tunnel.nodeHost ?? ""),
    nodeHost: typeof tunnel.nodeHost === "string" ? tunnel.nodeHost : undefined,
    nodePort: typeof tunnel.nodePort === "number" ? tunnel.nodePort : undefined,
    note: typeof tunnel.note === "string" ? tunnel.note : undefined,
  };
}

function normalizeTask(value: BackendTask): CloudDnsTask {
  const primaryTunnel = normalizeTunnel(parseJson(value.primaryTunnel ?? value.primary_tunnel, {}));
  const backupTunnels = parseJson<unknown[]>(value.backupTunnels ?? value.backup_tunnels, []).map(normalizeTunnel);
  const record = String(value.record ?? "");
  const domain = String(value.domain ?? "");
  const subdomain = String(value.subdomain ?? (record.endsWith(`.${domain}`) ? record.slice(0, -(domain.length + 1)) : record));
  return {
    id: String(value.id ?? ""),
    name: String(value.name ?? ""),
    enabled: Boolean(value.enabled),
    userToken: String(value.userToken ?? ""),
    credentialId: String(value.credentialId ?? value.credential_id ?? ""),
    domain,
    subdomain,
    primaryTunnel,
    backupTunnels,
    failThreshold: Number(value.failThreshold ?? value.fail_threshold ?? 2),
    recoverThreshold: Number(value.recoverThreshold ?? value.recoveryThreshold ?? value.recovery_threshold ?? 2),
    pollIntervalSecs: Number(value.pollIntervalSecs ?? value.poll_interval_secs ?? 60),
    checkMethods: parseJson<string[]>(value.checkMethods ?? value.check_methods, []),
    failMethodThreshold: Number(value.failMethodThreshold ?? value.methodFailThreshold ?? value.method_fail_threshold ?? 1),
    tcpingTimeoutSecs: Number(value.tcpingTimeoutSecs ?? value.tcping_timeout_secs ?? 3),
    executionTarget: (value.executionTarget ?? {
      type: value.execution_target_type,
      id: value.execution_target_id,
    }) as ExecutionTarget,
    revision: Number(value.revision ?? 0),
    runtimeStatus: typeof value.runtimeStatus === "string" ? value.runtimeStatus : undefined,
    executorOnline: typeof value.executorOnline === "boolean" ? value.executorOnline : undefined,
    lastSyncAt: typeof value.lastSyncAt === "string" ? value.lastSyncAt : undefined,
  };
}

type CredentialInput = Pick<DnsCredential, "name" | "provider" | "secretId" | "secretKey" | "token" | "tokenId" | "apiToken">;

function credentialPayload(credential: CredentialInput): Record<string, string> {
  switch (credential.provider) {
    case "dnspodCom": {
      const [tokenId, token] = (credential.token ?? "").split(",", 2);
      return { tokenId: credential.tokenId ?? tokenId ?? "", token: token ?? "" };
    }
    case "cloudflare":
      return { apiToken: credential.apiToken ?? "" };
    default:
      return { secretId: credential.secretId ?? "", secretKey: credential.secretKey ?? "" };
  }
}

function credentialPayloadForRequest(credential: CredentialInput): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    name: credential.name,
    provider: credential.provider,
  };
  const credentials = credentialPayload(credential);
  if (Object.values(credentials).some((value) => value.trim())) payload.credentials = credentials;
  return payload;
}

function normalizeLog(value: Record<string, unknown>): DnsSwitchLog {
  const details = (value.details ?? {}) as Record<string, unknown>;
  return {
    id: String(value.id ?? ""),
    taskId: String(value.taskId ?? ""),
    taskName: String(value.taskName ?? ""),
    kind: String(value.eventType ?? value.kind ?? ""),
    fromTunnel: String(value.fromTunnel ?? ""),
    toTunnel: String(value.toTunnel ?? details.activeTunnelId ?? ""),
    cnameValue: String(value.cnameValue ?? ""),
    success: value.level !== "error",
    message: String(value.message ?? ""),
    time: String(value.createdAt ?? value.time ?? ""),
  };
}

function getHeaders(): HeadersInit {
  const token = getStoredUser()?.proxyToken;
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BACKEND_API_BASE_URL}${path}`, {
    ...init,
    headers: { ...getHeaders(), ...(init?.headers ?? {}) },
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`DNS 容灾云端请求失败 (${response.status}): ${text}`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function taskPayload(task: DnsMonitorTask): Record<string, unknown> {
  const cloudTask = task as DnsMonitorTask & { executionTarget?: ExecutionTarget; revision?: number };
  const { userToken: _userToken, ownerUsername: _ownerUsername, ...safeTask } = task;
  const toBackendTunnel = (tunnel: TunnelTarget) => ({
    id: tunnel.id ?? tunnel.tunnelName,
    name: tunnel.tunnelName,
    tunnelName: tunnel.tunnelName,
    cnameValue: tunnel.cnameValue,
    nodeHost: tunnel.nodeHost ?? tunnel.cnameValue,
    nodePort: tunnel.nodePort,
    note: tunnel.note,
  });
  return {
    name: safeTask.name,
    enabled: safeTask.enabled,
    credentialId: safeTask.credentialId,
    domain: safeTask.domain,
    record: safeTask.subdomain ? `${safeTask.subdomain}.${safeTask.domain}` : safeTask.domain,
    recordType: "CNAME",
    primaryTunnel: toBackendTunnel(safeTask.primaryTunnel),
    backupTunnels: safeTask.backupTunnels.map(toBackendTunnel),
    checkMethods: safeTask.checkMethods,
    methodFailThreshold: safeTask.failMethodThreshold,
    failThreshold: safeTask.failThreshold,
    recoveryThreshold: safeTask.recoverThreshold,
    pollIntervalSecs: safeTask.pollIntervalSecs,
    tcpingTimeoutSecs: safeTask.tcpingTimeoutSecs,
    executionTarget: cloudTask.executionTarget ?? { type: "cloud", id: "xian-cloud" },
    revision: cloudTask.revision ?? 0,
  };
}

export const dnsFailoverCloudService = {
  async listExecutionTargets(): Promise<ExecutionTargetInfo[]> {
    const data = await request<{ targets?: ExecutionTargetInfo[] }>(
      "/api/dns-failover/execution-targets",
    );
    return data.targets ?? [];
  },

  async listTasks(): Promise<CloudDnsTask[]> {
    const data = await request<{ tasks?: BackendTask[] }>("/api/dns-failover/tasks");
    return (data.tasks ?? []).map(normalizeTask);
  },

  async listCredentials(): Promise<DnsCredential[]> {
    const data = await request<{ credentials?: DnsCredential[] }>("/api/dns-failover/credentials");
    return data.credentials ?? [];
  },

  async saveCredential(credential: DnsCredential): Promise<DnsCredential> {
    const method = credential.id ? "PUT" : "POST";
    const path = credential.id
      ? `/api/dns-failover/credentials/${encodeURIComponent(credential.id)}`
      : "/api/dns-failover/credentials";
    return request<DnsCredential>(path, { method, body: JSON.stringify(credentialPayloadForRequest(credential)) });
  },

  async verifyCredential(credential: DnsCredential): Promise<void> {
    if (credential.id) {
      await request<void>(`/api/dns-failover/credentials/${encodeURIComponent(credential.id)}/verify`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      return;
    }
    throw new Error("新凭证需直接保存并由云端验证");
  },

  async deleteCredential(id: string): Promise<void> {
    await request<void>(`/api/dns-failover/credentials/${encodeURIComponent(id)}`, { method: "DELETE" });
  },

  async importLocalData(payload: {
    migrationId: string;
    sourceDeviceId: string;
    tasks: DnsMonitorTask[];
    credentials: DnsCredential[];
    runtime: Record<string, TaskRuntime>;
  }): Promise<void> {
    const tasks = payload.tasks.map((task) => ({
      ...taskPayload({
      ...task,
      executionTarget: task.executionTarget ?? { type: "device", id: payload.sourceDeviceId },
      }),
      localId: task.id,
    }));
    const credentials = payload.credentials.map((credential) => {
      const { ownerUsername: _ownerUsername, id, ...safeCredential } = credential;
      return { ...credentialPayloadForRequest(safeCredential), localId: id };
    });
    const runtimes = Object.entries(payload.runtime).map(([taskId, value]) => ({
      taskId,
      failureCount: value.primaryFailCount,
      recoveryCount: value.primarySuccessCount,
      lastResult: value.lastResult,
    }));
    await request<void>("/api/dns-failover/migrations/import", {
      method: "POST",
      body: JSON.stringify({ migrationId: payload.migrationId, sourceDeviceId: payload.sourceDeviceId, tasks, credentials, runtimes }),
    });
  },

  async getTask(id: string): Promise<CloudDnsTask> {
    return normalizeTask(await request<BackendTask>(`/api/dns-failover/tasks/${encodeURIComponent(id)}`));
  },

  async saveTask(task: DnsMonitorTask, revision?: number): Promise<CloudDnsTask> {
    const cloudTask = task as DnsMonitorTask & { id?: string; revision?: number };
    const body = JSON.stringify({ ...taskPayload(task), revision: revision ?? cloudTask.revision ?? 0 });
    if (cloudTask.id) {
    return normalizeTask(await request<BackendTask>(`/api/dns-failover/tasks/${encodeURIComponent(cloudTask.id)}`, {
        method: "PUT",
        body,
      }));
    }
    return normalizeTask(await request<BackendTask>("/api/dns-failover/tasks", { method: "POST", body }));
  },

  async createTask(task: DnsMonitorTask): Promise<CloudDnsTask> {
    return normalizeTask(await request<BackendTask>("/api/dns-failover/tasks", {
      method: "POST",
      body: JSON.stringify(taskPayload(task)),
    }));
  },

  async deleteTask(id: string): Promise<void> {
    await request<void>(`/api/dns-failover/tasks/${encodeURIComponent(id)}`, { method: "DELETE" });
  },

  async enableTask(id: string, revision: number): Promise<CloudDnsTask> {
    return normalizeTask(await request<BackendTask>(`/api/dns-failover/tasks/${encodeURIComponent(id)}/enable`, {
      method: "POST",
      body: JSON.stringify({ revision }),
    }));
  },

  async disableTask(id: string, revision: number): Promise<CloudDnsTask> {
    return normalizeTask(await request<BackendTask>(`/api/dns-failover/tasks/${encodeURIComponent(id)}/disable`, {
      method: "POST",
      body: JSON.stringify({ revision }),
    }));
  },

  async checkTask(id: string): Promise<void> {
    await request<void>(`/api/dns-failover/tasks/${encodeURIComponent(id)}/check-now`, { method: "POST" });
  },

  async listRuntime(): Promise<Record<string, CloudDnsRuntime>> {
    const tasks = await this.listTasks();
    return Object.fromEntries(tasks.map((task) => [task.id, {
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
    }]));
  },

  async listLogs(id: string, cursor?: string): Promise<{ logs: DnsSwitchLog[]; nextCursor?: string }> {
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}&limit=100` : "?limit=100";
    const page = await request<{ items?: Record<string, unknown>[]; logs?: DnsSwitchLog[]; nextCursor?: string }>(
      `/api/dns-failover/tasks/${encodeURIComponent(id)}/logs${query}`,
    );
    return { logs: (page.logs ?? page.items ?? []).map((item) => normalizeLog(item as Record<string, unknown>)), nextCursor: page.nextCursor ?? undefined };
  },

  async clearLogs(id: string): Promise<void> {
    await request<void>(`/api/dns-failover/tasks/${encodeURIComponent(id)}/logs`, { method: "DELETE" });
  },
};
