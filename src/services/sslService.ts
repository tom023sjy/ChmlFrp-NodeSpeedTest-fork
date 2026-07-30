import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** ChmlFrp 免费域名凭证的特殊标识（与后端保持一致） */
export const CHMLFRP_CREDENTIAL_ID = "__chmlfrp__";

/** SSL 证书申请记录 */
export interface SslCertificate {
  id: number;
  provider: string;
  domains: string;
  challengeType?: string;
  status: string;
  createdAt: string;
  updatedAt?: string;
  issuedAt?: string;
  expiresAt?: string;
  challengeToken?: string;
  challengeKeyAuthorization?: string;
  errorMessage?: string;
  instructions?: string;
  dnsRecordName?: string;
  dnsRecordValue?: string;
}

/** 申请证书的请求参数 */
export interface SslRequestParams {
  provider: string;
  domains: string[];
  challengeType: string;
  credentialId: string;
}

/** 自动申请结果 */
export interface SslAutoRequestResult {
  id: number;
  finalStatus: string;
  certificate: SslCertificate;
  logs: string[];
}

/** 后台申请进度事件 payload */
export interface SslRequestProgress {
  taskId: string;
  certId: number | null;
  stage: "requesting" | "adding_txt" | "waiting_dns" | "verifying" | "polling" | "done" | "error";
  message: string;
  isFinal: boolean;
  finalStatus: string | null;
}

/** 一条历史申请日志（持久化存储） */
export interface SslRequestLog {
  id: string;
  domains: string;
  provider: string;
  finalStatus: string;
  logs: string[];
  createdAt: string;
  finishedAt: string;
  ownerUsername?: string;
}

export class SslService {
  /** 获取 SSL 证书列表 */
  async list(): Promise<SslCertificate[]> {
    return invoke<SslCertificate[]>("ssl_list");
  }

  /** 获取 SSL 证书详情 */
  async detail(id: number): Promise<SslCertificate> {
    return invoke<SslCertificate>("ssl_detail", { id });
  }

  /** 申请 SSL 证书（仅创建申请，不自动验证） */
  async request(params: SslRequestParams): Promise<SslCertificate> {
    return invoke<SslCertificate>("ssl_request", { params });
  }

  /** 触发域名验证 */
  async verify(id: number): Promise<SslCertificate> {
    return invoke<SslCertificate>("ssl_verify", { id });
  }

  /** 删除 SSL 证书 */
  async delete(id: number): Promise<void> {
    return invoke<void>("ssl_delete", { id });
  }

  /** 自动申请 SSL 证书（一键完成：申请 → 添加 TXT → 验证 → 轮询） */
  async autoRequest(
    username: string,
    params: SslRequestParams,
  ): Promise<SslAutoRequestResult> {
    return invoke<SslAutoRequestResult>("ssl_auto_request", { username, params });
  }

  /**
   * 异步申请 SSL 证书（后台执行，立即返回任务 ID）
   * 进度通过 onProgress 回调实时推送，完成后调用 onComplete
   * @returns 取消监听的函数
   */
  async autoRequestAsync(
    username: string,
    params: SslRequestParams,
    onProgress: (p: SslRequestProgress) => void,
  ): Promise<() => void> {
    const taskId = await invoke<string>("ssl_auto_request_async", { username, params });
    const unlisten = await listen<SslRequestProgress>("ssl-request-progress", (event) => {
      if (event.payload.taskId === taskId) {
        onProgress(event.payload);
      }
    });
    return unlisten;
  }

  /** 保存一条申请日志（申请完成时调用） */
  async saveLog(log: SslRequestLog): Promise<void> {
    return invoke<void>("ssl_save_log", { log });
  }

  /** 列出当前用户的所有申请日志 */
  async listLogs(username: string): Promise<SslRequestLog[]> {
    return invoke<SslRequestLog[]>("ssl_list_logs", { username });
  }

  /** 清空当前用户的所有申请日志 */
  async clearLogs(username: string): Promise<void> {
    return invoke<void>("ssl_clear_logs", { username });
  }
}

export const sslService = new SslService();
