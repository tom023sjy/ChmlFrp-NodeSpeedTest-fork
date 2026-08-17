export interface RemoteCleanupResponse {
  success: boolean;
  data: { cleaned: boolean; reason?: string } | null;
  error: { code: string; message: string } | null;
}

interface RemoteCleanupOptions {
  maxAttempts?: number;
  retryDelayMs?: number;
}

export async function cleanupRemoteResources(
  requestCleanup: () => Promise<RemoteCleanupResponse>,
  options: RemoteCleanupOptions = {},
): Promise<void> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 8);
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? 500);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const response = await requestCleanup();
    if (!response.success) {
      throw new Error(response.error?.message ?? "远程资源清理失败");
    }
    if (response.data?.cleaned === true || response.data?.reason === "RUN_NOT_ACTIVE") {
      return;
    }
    if (response.data?.reason !== "CLEANUP_IN_PROGRESS") {
      throw new Error(response.data?.reason ?? "远程资源清理失败");
    }
    if (attempt < maxAttempts && retryDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }

  throw new Error("资源清理超时，请稍后检查设备状态");
}
