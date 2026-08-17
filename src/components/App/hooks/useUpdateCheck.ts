import { useEffect, useState } from "react";
import { updateService, type UpdateInfo } from "@/services/updateService";
import { reportUsage } from "@/services/backendApi";
import { getStoredUser } from "@/services/api";

/** 已登录时上报事件，失败静默处理 */
function reportUsageIfLoggedIn(eventType: string, eventData?: Record<string, unknown>): void {
  if (!getStoredUser()?.accessToken) return;
  reportUsage({ eventType, eventData }).catch(() => {});
}

export function useUpdateCheck() {
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);

  useEffect(() => {
    const checkUpdateOnStart = async () => {
      if (!updateService.getAutoCheckEnabled()) {
        return;
      }

      try {
        const result = await updateService.checkUpdate();
        // 自动检查成功（确认为真实结果）
        reportUsageIfLoggedIn("update_check_success", { auto: true, available: result.available });
        if (result.available) {
          // 发现新版本
          reportUsageIfLoggedIn("update_available", {
            auto: true,
            version: result.version || null,
            mandatory: !!result.mandatory,
          });
          setUpdateInfo({
            version: result.version || "",
            date: result.date,
            body: result.body,
            mandatory: result.mandatory,
          });
        }
      } catch (error) {
        console.error("自动检测更新失败:", error);
        // 自动检查失败（确认为真实失败）
        const reason = error instanceof Error ? error.message : String(error);
        reportUsageIfLoggedIn("update_check_failure", { auto: true, reason });
      }
    };

    const timer = setTimeout(() => {
      checkUpdateOnStart();
    }, 2000);

    return () => clearTimeout(timer);
  }, []);

  return {
    updateInfo,
    setUpdateInfo,
  };
}
