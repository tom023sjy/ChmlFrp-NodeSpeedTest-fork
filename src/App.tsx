import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { Sidebar } from "@/components/Sidebar";
import { TitleBar, WindowControls } from "@/components/TitleBar";
import { NodeTest } from "@/components/pages/NodeTest";
import { Settings } from "@/components/pages/Settings";
import { About } from "@/components/pages/About";
import { DnsFailover } from "@/components/pages/DnsFailover";
import { DnsManagement } from "@/components/pages/DnsManagement";
import { SslManagement } from "@/components/pages/SslManagement";
import { SslProgressProvider } from "@/components/pages/SslManagement/SslProgressContext";
import { DnsCredentials } from "@/components/pages/DnsCredentials";
import { DeviceManagement } from "@/components/pages/DeviceManagement";
import { getStoredUser, clearStoredUser, fetchUserInfo, initSecureStorage, ProxyTokenError, type StoredUser } from "@/services/api";
import { reportUsage } from "@/services/backendApi";
import { getRelayClient } from "@/services/deviceRelay";
import { registerRelayHandlers } from "@/services/relayHandlers";
import { getDeviceId } from "@/services/deviceId";
import { useAppTheme } from "@/components/App/hooks/useAppTheme";
import { useTitleBar } from "@/components/App/hooks/useTitleBar";
import { useBackground } from "@/components/App/hooks/useBackground";
import { useUpdateCheck } from "@/components/App/hooks/useUpdateCheck";
import { BackgroundLayer } from "@/components/App/components/BackgroundLayer";
import { UpdateDialog } from "@/components/dialogs/UpdateDialog";
import { CloseConfirmDialog } from "@/components/dialogs/CloseConfirmDialog";
import { AnnouncementDialog } from "@/components/dialogs/AnnouncementDialog";
import { FeatureUnavailable } from "@/components/FeatureUnavailable";
import {
  defaultRuntimeConfig,
  fetchAppRuntimeConfig,
  findNewAnnouncements,
  isAnnouncementRead,
  isRuntimeConfigEqual,
  markAnnouncementRead,
  readAppRuntimeConfig,
  RUNTIME_CONFIG_REFRESH_INTERVAL_MS,
  writeAppRuntimeConfig,
  type Announcement,
  type RuntimeConfig,
} from "@/services/appRuntimeConfig";
import { setFeatureAvailabilities } from "@/services/featureAvailability";
import { getInitialSidebarMode, getCloseAction, type SidebarMode } from "@/lib/settings-utils";
import { updateService } from "@/services/updateService";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";

/** 已登录时上报事件，失败静默处理 */
function reportUsageIfLoggedIn(eventType: string, eventData?: Record<string, unknown>): void {
  if (!getStoredUser()?.accessToken) return;
  reportUsage({ eventType, eventData }).catch(() => {});
}

function App() {
  const [activeTab, setActiveTab] = useState("node-test");
  const [user, setUser] = useState<StoredUser | null>(null);

  // 启动时从加密数据库加载登录状态
  useEffect(() => {
    initSecureStorage().then((hasUser) => {
      if (hasUser) {
        setUser(getStoredUser());
      }
    });
  }, []);
  const initialSidebarMode = getInitialSidebarMode();
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() =>
    initialSidebarMode !== "classic",
  );
  const [isTesting, setIsTesting] = useState(false);
  const isMacOS =
    typeof navigator !== "undefined" &&
    navigator.platform.toUpperCase().indexOf("MAC") >= 0;
  const isWindows =
    typeof navigator !== "undefined" &&
    navigator.platform.toUpperCase().indexOf("WIN") >= 0;

  useAppTheme();
  const { showTitleBar } = useTitleBar();
  const { updateInfo, setUpdateInfo } = useUpdateCheck();
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(0);
  // 安装包是否已下载完成，等待用户确认重启
  const [downloaded, setDownloaded] = useState(false);
  // 下载完成的安装包路径，供用户确认后调用安装
  const [installerPath, setInstallerPath] = useState<string | null>(null);
  // 关闭确认对话框（由后端 window-close-requested 事件触发）
  const [showCloseDialog, setShowCloseDialog] = useState(false);
  const [runtimeConfig, setRuntimeConfig] = useState<RuntimeConfig>(defaultRuntimeConfig);
  const [pendingAnnouncements, setPendingAnnouncements] = useState<Announcement[]>([]);
  const [announcementRefreshing, setAnnouncementRefreshing] = useState(false);

  const shouldShowTitleBar = isMacOS
    ? showTitleBar
    : isWindows
      ? showTitleBar
      : true;
  const isTitleBarHidden = (isMacOS || isWindows) && !showTitleBar;
  const shouldPadTop = shouldShowTitleBar || (isWindows && !showTitleBar);
  const SIDEBAR_LEFT = isMacOS && !showTitleBar ? 10 : 15;
  const SIDEBAR_COLLAPSED_WIDTH = Math.round(((20 * 5) / 3) * 2);
  const appContainerRef = useRef<HTMLDivElement>(null);
  // 应用启动埋点标记：仅在上报一次 app_launch 后置位，避免重复上报
  const appLaunchReportedRef = useRef(false);
  const {
    backgroundImage,
    imageSrc,
    overlayOpacity,
    blur,
    effectType,
    videoLoadError,
    videoRef,
    videoStartSound,
    videoVolume,
    videoSrc,
    backgroundType,
    getBackgroundColorWithOpacity,
  } = useBackground();

  const [sidebarMode, setSidebarMode] = useState<SidebarMode>(() =>
    initialSidebarMode,
  );

  const handleTestingChange = useCallback((testing: boolean) => {
    setIsTesting(testing);
  }, []);

  useEffect(() => {
    const handleSidebarModeChange = () => {
      const nextMode = getInitialSidebarMode();
      setSidebarMode(nextMode);
      setSidebarCollapsed(nextMode !== "classic");
    };
    window.addEventListener("sidebarModeChanged", handleSidebarModeChange);
    return () =>
      window.removeEventListener("sidebarModeChanged", handleSidebarModeChange);
  }, []);

  const handleTabChange = (tab: string) => {
    setActiveTab(tab);
  };

  useEffect(() => {
    const account = user?.username || "anonymous";
    const cached = readAppRuntimeConfig(account);
    const initial = cached ?? defaultRuntimeConfig();
    setRuntimeConfig(initial);
    setFeatureAvailabilities(initial.features);

    let cancelled = false;
    let refreshing = false;
    const refresh = async () => {
      if (refreshing) return;
      refreshing = true;
      try {
        const fresh = await fetchAppRuntimeConfig();
        if (cancelled) return;
        setRuntimeConfig((current) => {
          if (isRuntimeConfigEqual(current, fresh)) return current;
          writeAppRuntimeConfig(account, fresh);
          return fresh;
        });
        setFeatureAvailabilities(fresh.features);
      } catch {
        return;
      } finally {
        refreshing = false;
      }
    };
    void refresh();
    const interval = window.setInterval(refresh, RUNTIME_CONFIG_REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [user?.username]);

  useEffect(() => {
    setFeatureAvailabilities(runtimeConfig.features);
    const account = user?.username || "anonymous";
    setPendingAnnouncements(runtimeConfig.announcements
      .filter((announcement) => !isAnnouncementRead(account, announcement))
      .sort((left, right) => right.sortOrder - left.sortOrder
        || Date.parse(right.publishedAt) - Date.parse(left.publishedAt)));
  }, [activeTab, runtimeConfig, user?.username]);

  const handleAnnouncementClose = useCallback(() => {
    const account = user?.username || "anonymous";
    pendingAnnouncements.forEach((announcement) => markAnnouncementRead(account, announcement));
    setPendingAnnouncements([]);
  }, [pendingAnnouncements, user?.username]);

  const handleRefreshAnnouncements = useCallback(async () => {
    if (announcementRefreshing) return;
    setAnnouncementRefreshing(true);
    try {
      const fresh = await fetchAppRuntimeConfig();
      const newAnnouncements = findNewAnnouncements(runtimeConfig.announcements, fresh.announcements);
      setRuntimeConfig(fresh);
      setFeatureAvailabilities(fresh.features);
      writeAppRuntimeConfig(user?.username || "anonymous", fresh);
      if (newAnnouncements.length > 0) {
        setPendingAnnouncements(newAnnouncements);
        toast.success(`发现 ${newAnnouncements.length} 条新公告`);
      } else {
        toast.success("公告已是最新");
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "刷新公告失败");
    } finally {
      setAnnouncementRefreshing(false);
    }
  }, [announcementRefreshing, runtimeConfig.announcements, user?.username]);

  const backgroundStyle = useMemo(() => {
    if (!backgroundImage) {
      return { backgroundColor: getBackgroundColorWithOpacity(100) };
    }
    return {};
  }, [backgroundImage, getBackgroundColorWithOpacity]);

  const handleVideoError = () => {};

  const handleVideoLoadedData = useCallback(() => {
    if (videoRef.current) {
      videoRef.current.volume = videoVolume / 100;
      videoRef.current.play().catch(() => {});
    }
  }, [videoRef, videoVolume]);

  const handleUpdate = useCallback(async () => {
    // 关闭更新提示对话框，下载进度改由设置页 UpdateSection 显示
    setUpdateInfo(null);
    setIsDownloading(true);
    setDownloadProgress(0);
    setDownloaded(false);
    setInstallerPath(null);
    // 上报开始下载更新（确认为真实用户意图）
    reportUsageIfLoggedIn("update_download_start", {});
    try {
      // 仅下载安装包，不自动重启
      const filePath = await updateService.downloadUpdate((progress) => {
        setDownloadProgress(progress);
      });
      setInstallerPath(filePath);
      setDownloaded(true);
      toast.success("更新已下载完成，可随时重启安装");
      // 下载成功（确认为真实结果）
      reportUsageIfLoggedIn("update_download_success", {});
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      toast.error(error instanceof Error ? error.message : "下载更新失败");
      // 下载失败（确认为真实失败）
      reportUsageIfLoggedIn("update_download_failure", { reason });
    } finally {
      setIsDownloading(false);
    }
  }, [setUpdateInfo]);

  // 用户确认后运行安装包并退出当前应用
  const handleInstall = useCallback(async () => {
    if (!installerPath) {
      toast.error("安装包路径丢失，请重新下载");
      setDownloaded(false);
      return;
    }
    // 上报开始安装更新（确认为真实用户意图）
    // 注意：installUpdate 成功后应用会退出，"安装成功"需新版本启动后确认
    // 按"仅准确事件"口径，此处只上报 update_install_start
    reportUsageIfLoggedIn("update_install_start", {});
    try {
      await updateService.installUpdate(installerPath);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "启动安装失败";
      // 安装启动失败（确认为真实失败）
      reportUsageIfLoggedIn("update_install_failure", { reason: errorMsg });
      toast.error(errorMsg, {
        action: {
          label: "手动下载",
          onClick: () => {
            void openUrl(updateService.getReleaseUrl());
          },
        },
      });
    }
  }, [installerPath]);

  const content = useMemo(() => {
    switch (activeTab) {
      case "node-test":
        if (!runtimeConfig.features.nodeTesting.enabled) {
          return <FeatureUnavailable title="节点推荐" reason={runtimeConfig.features.nodeTesting.reason} />;
        }
        return <NodeTest user={user} onTestingChange={handleTestingChange} />;
      case "dns-failover":
        if (!runtimeConfig.features.dnsFailover.enabled) {
          return <FeatureUnavailable title="DNS 容灾" reason={runtimeConfig.features.dnsFailover.reason} />;
        }
        return <DnsFailover user={user} />;
      case "dns-management":
        if (!runtimeConfig.features.ddns.enabled) {
          return <FeatureUnavailable title="DDNS 解析" reason={runtimeConfig.features.ddns.reason} />;
        }
        return <DnsManagement user={user} />;
      case "dns-credentials":
        if (!runtimeConfig.features.dnsCredentials.enabled) {
          return <FeatureUnavailable title="DNS 服务商" reason={runtimeConfig.features.dnsCredentials.reason} />;
        }
        return <DnsCredentials user={user} />;
      case "ssl-certs":
        if (!runtimeConfig.features.sslCertificates.enabled) {
          return <FeatureUnavailable title="SSL 证书" reason={runtimeConfig.features.sslCertificates.reason} />;
        }
        return <SslManagement user={user} />;
      case "device-management":
        if (!runtimeConfig.features.deviceManagement.enabled) {
          return <FeatureUnavailable title="设备管理" reason={runtimeConfig.features.deviceManagement.reason} />;
        }
        return <DeviceManagement user={user} />;
      case "settings":
        return (
          <Settings
            isDownloading={isDownloading}
            downloadProgress={downloadProgress}
            downloaded={downloaded}
            installerPath={installerPath}
            onUpdate={handleUpdate}
            onInstall={handleInstall}
          />
        );
      case "about":
        return (
          <About
            announcements={runtimeConfig.announcements}
            announcementRefreshing={announcementRefreshing}
            onRefreshAnnouncements={() => void handleRefreshAnnouncements()}
          />
        );
      default:
        return <NodeTest user={user} onTestingChange={handleTestingChange} />;
    }
  }, [activeTab, user, handleTestingChange, isDownloading, downloadProgress, downloaded, installerPath, handleUpdate, handleInstall, runtimeConfig, announcementRefreshing, handleRefreshAnnouncements]);

  const handleCloseUpdateDialog = useCallback(() => {
    setUpdateInfo(null);
    // 仅关闭弹窗，保留 downloaded 状态以便侧边栏"立即更新"按钮继续显示
  }, [setUpdateInfo]);

  // 应用启动时检查是否有未完成的待安装更新（上次下载完成但未安装）
  useEffect(() => {
    const restorePendingInstaller = async () => {
      const pendingPath = await updateService.getPendingInstaller();
      if (pendingPath) {
        setInstallerPath(pendingPath);
        setDownloaded(true);
      }
    };
    restorePendingInstaller();
  }, []);

  // 监听后端窗口关闭请求事件
  // 根据用户记忆的关闭行为决定：直接执行（minimize/exit）或弹出确认对话框（ask）
  useEffect(() => {
    let unlistenFn: (() => void) | null = null;
    const setupListener = async () => {
      const { listen } = await import("@tauri-apps/api/event");
      unlistenFn = await listen("window-close-requested", () => {
        const action = getCloseAction();
        if (action === "minimize") {
          invoke("minimize_to_tray").catch((e) =>
            toast.error(e instanceof Error ? e.message : "最小化失败"),
          );
        } else if (action === "exit") {
          invoke("exit_app").catch((e) =>
            toast.error(e instanceof Error ? e.message : "退出失败"),
          );
        } else {
          // ask: 每次询问，弹出确认对话框
          setShowCloseDialog(true);
        }
      });
    };
    setupListener();
    return () => {
      if (unlistenFn) unlistenFn();
    };
  }, []);

  // 登录状态变化时，推送 accessToken 给后端（DNS 容灾调度器请求 /tunnel 时使用）
  useEffect(() => {
    if (user?.accessToken) {
      invoke("set_user_token", { token: user.accessToken }).catch(() => {});
    }
  }, [user]);

  // 设备互联：注册本机 RPC 命令处理器（仅需执行一次）
  // 使本机作为被管理端时能响应远程命令
  useEffect(() => {
    const relay = getRelayClient();
    const unregister = registerRelayHandlers(relay);
    return unregister;
  }, []);

  // 设备互联：登录后建立 WebSocket 中继连接，登出时断开
  // 互联开关变化时也会触发重新连接（通过 interconnectVersion 递增）
  const [interconnectVersion, setInterconnectVersion] = useState(0);
  useEffect(() => {
    const handler = () => setInterconnectVersion((v) => v + 1);
    window.addEventListener("interconnectChanged", handler);
    return () => window.removeEventListener("interconnectChanged", handler);
  }, []);

  useEffect(() => {
    const relay = getRelayClient();
    if (!user?.proxyToken) {
      relay.disconnect();
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const deviceId = await getDeviceId();
        const sysInfo = await invoke<{ osInfo: string; hostname: string }>("get_system_info");
        const interconnect = localStorage.getItem("interconnect_enabled") === "true";
        if (cancelled) return;
        await relay.connect(user.proxyToken!, deviceId, {
          deviceType: "desktop",
          osInfo: sysInfo.osInfo,
          hostname: sysInfo.hostname,
          interconnect,
          capabilities: ["dns_failover_probe.v1", "full_chain_test.v2"],
        });
      } catch (err) {
        console.warn("[relay] 连接失败:", err);
      }
    })();
    return () => {
      cancelled = true;
      relay.disconnect();
    };
  }, [user, interconnectVersion]);

  // 定期检查登录状态，避免 token 过期或服务端踢下线后用户无感知
  // 每 2 分钟调用一次 /userinfo 接口验证；fetchUserInfo 内部会自动触发
  // access_token 刷新（提前 60 秒）和 proxyToken 过期检测
  // 同时把最新 accessToken 推送给后端（DNS 容灾调度器使用）
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    const CHECK_INTERVAL_MS = 2 * 60 * 1000;

    const checkLogin = async () => {
      try {
        await fetchUserInfo();
        // 静默成功：token 仍有效，不提示避免打扰
        // 推送最新 token 给后端（fetchUserInfo 内部可能已刷新 token 并写入数据库）
        const latest = getStoredUser();
        if (latest?.accessToken) {
          invoke("set_user_token", { token: latest.accessToken }).catch(() => {});
        }
      } catch (err) {
        if (cancelled) return;
        // ProxyTokenError 表示代理令牌或 qzhua refresh_token 失效，必须重新登录
        if (err instanceof ProxyTokenError) {
          clearStoredUser();
          setUser(null);
          toast.error("登录状态已失效，请重新登录");
          return;
        }
        const msg = err instanceof Error ? err.message : String(err);
        // 仅在明确是认证类错误时清除登录，避免网络抖动误清除
        if (/登录|过期|token|认证|unauthorized|401/i.test(msg)) {
          clearStoredUser();
          setUser(null);
          toast.error("登录状态已失效，请重新登录");
        }
      }
    };

    const timer = window.setInterval(checkLogin, CHECK_INTERVAL_MS);
    // 启动时立即执行一次，确保后端尽快拿到有效 token
    checkLogin();
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [user]);

  // 应用启动埋点：用户已登录时上报一次 app_launch，失败静默不影响主流程
  useEffect(() => {
    if (appLaunchReportedRef.current) return;
    if (!user?.accessToken) return;
    appLaunchReportedRef.current = true;
    reportUsage({ eventType: "app_launch" }).catch(() => {});
  }, [user]);

  return (
    <SslProgressProvider>
      <UpdateDialog
        isOpen={updateInfo !== null}
        onClose={handleCloseUpdateDialog}
        onUpdate={handleUpdate}
        onInstall={handleInstall}
        version={updateInfo?.version || ""}
        date={updateInfo?.date}
        body={updateInfo?.body}
        isDownloading={isDownloading}
        downloaded={downloaded}
        downloadProgress={downloadProgress}
      />
      <CloseConfirmDialog
        isOpen={showCloseDialog}
        onClose={() => setShowCloseDialog(false)}
        user={user}
      />
      <AnnouncementDialog
        announcements={pendingAnnouncements}
        onConfirm={handleAnnouncementClose}
        onRefresh={handleRefreshAnnouncements}
      />
      <div
        ref={appContainerRef}
        className={`flex flex-col h-screen w-screen overflow-hidden text-foreground ${
          backgroundImage && effectType === "frosted"
            ? "frosted-glass-enabled"
            : ""
        } ${
          backgroundImage && effectType === "translucent"
            ? "translucent-enabled"
            : ""
        }`}
        style={{
          ...backgroundStyle,
          borderRadius: "0",
          overflow: "hidden",
          position: "relative",
        }}
      >
        <BackgroundLayer
          backgroundImage={backgroundImage}
          imageSrc={imageSrc}
          backgroundType={backgroundType}
          videoSrc={videoSrc}
          videoLoadError={videoLoadError}
          videoRef={videoRef}
          videoStartSound={videoStartSound}
          overlayOpacity={overlayOpacity}
          blur={blur}
          getBackgroundColorWithOpacity={getBackgroundColorWithOpacity}
          appContainerRef={appContainerRef}
          onVideoError={handleVideoError}
          onVideoLoadedData={handleVideoLoadedData}
        />
        {shouldShowTitleBar && (
          <div className="relative z-50">
            <TitleBar />
          </div>
        )}
        {isWindows && !showTitleBar ? (
          <div
            data-tauri-drag-region
            className="absolute top-0 right-0 left-0 z-50 h-9 flex items-center justify-end pr-2"
          >
            <WindowControls />
          </div>
        ) : null}
        {sidebarMode === "floating" || sidebarMode === "floating_fixed" ? (
          <>
            <div
              className="absolute z-50"
              style={{
                left: `${SIDEBAR_LEFT}px`,
                top: isTitleBarHidden
                  ? isMacOS
                    ? "10px"
                    : "12px"
                  : "48px",
                bottom: "12px",
              }}
            >
              <Sidebar
                activeTab={activeTab}
                onTabChange={handleTabChange}
                user={user}
                onUserChange={setUser}
                collapsed={sidebarCollapsed}
                onCollapseChange={setSidebarCollapsed}
                collapsedWidth={SIDEBAR_COLLAPSED_WIDTH}
                mode={sidebarMode}
                disabled={isTesting}
                hasPendingUpdate={downloaded}
                onInstallUpdate={handleInstall}
                deviceManagementEnabled={runtimeConfig.features.deviceManagement.enabled}
                deviceManagementReason={runtimeConfig.features.deviceManagement.reason}
                sslCertificatesEnabled={runtimeConfig.features.sslCertificates.enabled}
                sslCertificatesReason={runtimeConfig.features.sslCertificates.reason}
                features={runtimeConfig.features}
              />
            </div>

            <div
              className="absolute z-40 overflow-hidden rounded-b-[12px]"
              style={{
                left: `${SIDEBAR_LEFT + SIDEBAR_COLLAPSED_WIDTH}px`,
                right: "0",
                top: shouldPadTop ? "36px" : "0",
                bottom: "0",
              }}
            >
              {isMacOS && !showTitleBar ? (
                <div
                  data-tauri-drag-region
                  className="absolute top-0 left-0 right-0 h-8 z-10"
                />
              ) : null}
              <div className="h-full overflow-auto px-6 pt-4 pb-6 md:px-8 md:pt-6 md:pb-8">
                <div className="max-w-6xl mx-auto w-full h-full">
                  <div className="h-full flex flex-col">{content}</div>
                </div>
              </div>
            </div>
          </>
        ) : (
          <div className="relative flex flex-1 overflow-hidden">
            <Sidebar
              activeTab={activeTab}
              onTabChange={handleTabChange}
              user={user}
              onUserChange={setUser}
              mode="classic"
              disabled={isTesting}
              hasPendingUpdate={downloaded}
              onInstallUpdate={handleInstall}
              deviceManagementEnabled={runtimeConfig.features.deviceManagement.enabled}
              deviceManagementReason={runtimeConfig.features.deviceManagement.reason}
              sslCertificatesEnabled={runtimeConfig.features.sslCertificates.enabled}
              sslCertificatesReason={runtimeConfig.features.sslCertificates.reason}
              features={runtimeConfig.features}
            />
            <div className="flex-1 flex flex-col overflow-hidden relative">
              {isMacOS && !showTitleBar ? (
                <div
                  data-tauri-drag-region
                  className="h-8 flex-shrink-0 w-full"
                />
              ) : null}
              <div
                className={`flex-1 overflow-auto px-6 pb-6 md:px-8 md:pb-8 ${shouldPadTop ? "pt-4 md:pt-6" : "pt-0"}`}
              >
                <div className="max-w-6xl mx-auto w-full h-full">
                  <div className="h-full flex flex-col">{content}</div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </SslProgressProvider>
  );
}

export default App;
