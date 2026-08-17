import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { getStoredUser } from "@/services/api";
import {
  getAttachmentPreviewUrl,
  type IssueAttachment,
} from "@/services/backendApi";

const inFlight = new Map<string, Promise<string>>();
const cacheDownloads = new Map<string, Promise<void>>();

function attachmentCacheKey(
  account: string,
  issueId: number,
  attachment: IssueAttachment,
): string {
  return `${account}:${issueId}:${attachment.id}:${attachment.mimeType}`;
}

async function loadAttachmentUrl(
  key: string,
  account: string,
  issueId: number,
  attachment: IssueAttachment,
  onCached?: (url: string) => void,
): Promise<string> {
  try {
    const cachedPath = await invoke<string | null>("get_issue_attachment_cache_path", {
      account,
      issueId,
      attachmentId: attachment.id,
      mimeType: attachment.mimeType,
    });
    if (cachedPath) return convertFileSrc(cachedPath);
  } catch {
  }

  const preview = await getAttachmentPreviewUrl(issueId, attachment.id);
  if (!cacheDownloads.has(key)) {
    const download = invoke<string>("cache_issue_attachment", {
      account,
      issueId,
      attachmentId: attachment.id,
      mimeType: attachment.mimeType,
      url: preview.url,
    })
      .then((cachedPath) => {
        onCached?.(convertFileSrc(cachedPath));
      })
      .catch((error) => {
        console.warn("工单附件缓存失败", {
          issueId,
          attachmentId: attachment.id,
          error,
        });
      })
      .finally(() => cacheDownloads.delete(key));
    cacheDownloads.set(key, download);
  }
  return preview.url;
}

export function resolveIssueAttachmentUrl(
  issueId: number,
  attachment: IssueAttachment,
  onCached?: (url: string) => void,
): Promise<string> {
  const account = getStoredUser()?.username || "anonymous";
  const key = attachmentCacheKey(account, issueId, attachment);
  const pending = inFlight.get(key);
  if (pending) return pending;

  const request = loadAttachmentUrl(
    key,
    account,
    issueId,
    attachment,
    onCached,
  ).finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, request);
  return request;
}

export async function clearIssueAttachmentCache(): Promise<number> {
  await Promise.allSettled(cacheDownloads.values());
  inFlight.clear();
  cacheDownloads.clear();
  return invoke<number>("clear_issue_attachment_cache");
}
