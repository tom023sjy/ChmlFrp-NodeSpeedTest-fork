import { useState, useEffect, useCallback, useMemo } from "react";
import {
  Palette,
  Sparkles,
  Settings2,
  MonitorSmartphone,
  Trash2,
  Search,
  X,
} from "lucide-react";
import { useTheme } from "./hooks/useTheme";
import { useBackgroundImage } from "./hooks/useBackgroundImage";
import {
  getInitialShowTitleBar,
  getInitialEffectType,
  getInitialVideoStartSound,
  getInitialVideoVolume,
  getInitialSidebarMode,
  type EffectType,
  type SidebarMode,
} from "./utils";
import { AppearanceSection } from "./components/AppearanceSection";
import { UpdateSection } from "./components/UpdateSection";
import { GeneralSection } from "./components/GeneralSection";
import { InterconnectSection } from "./components/InterconnectSection";
import { MaintenanceSection } from "./components/MaintenanceSection";
import { SectionCard } from "./components/SectionCard";
import { SidebarVisibilityDialog } from "@/components/dialogs/SidebarVisibilityDialog";
import { UpdateDialog } from "@/components/dialogs/UpdateDialog";
import { updateService, type UpdateInfo } from "@/services/updateService";
import { toast } from "sonner";
import { openUrl } from "@tauri-apps/plugin-opener";
import { reportUsage } from "@/services/backendApi";
import { getStoredUser } from "@/services/api";
import { getCloseAction, type CloseAction } from "@/lib/settings-utils";
import { getInterconnectEnabled } from "./components/InterconnectSection";

/** 已登录时上报事件，失败静默处理 */
function reportUsageIfLoggedIn(eventType: string, eventData?: Record<string, unknown>): void {
  if (!getStoredUser()?.accessToken) return;
  reportUsage({ eventType, eventData }).catch(() => {});
}

// ===== 设置分组手风琴（单展开 + localStorage 记忆）=====

/** 设置分组 ID（顺序即展示顺序） */
const SETTINGS_SECTION_IDS = [
  "appearance",
  "update",
  "general",
  "interconnect",
  "maintenance",
] as const;

type SettingsSectionId = (typeof SETTINGS_SECTION_IDS)[number];

/** localStorage 持久化 key：记住上次展开的分组 */
const EXPANDED_SECTION_KEY = "settingsExpandedSection";

/** 读取初始展开分组：非法值/首次打开时默认「个性化」 */
function getInitialExpandedSection(): SettingsSectionId {
  const saved = localStorage.getItem(EXPANDED_SECTION_KEY);
  return (SETTINGS_SECTION_IDS as readonly string[]).includes(saved ?? "")
    ? (saved as SettingsSectionId)
    : "appearance";
}

/** 各分组搜索关键词（标题+设置项名称，供搜索过滤定位） */
const SECTION_KEYWORDS: Record<SettingsSectionId, string> = {
  appearance: "个性化 主题 深色 浅色 跟随系统 侧边栏 样式 显示项目 背景 图片 视频 特效 标题栏 音量 声音 毛玻璃 模糊 透明度",
  update: "更新 版本 检查更新 自动检查 下载 安装 立即更新 升级",
  general: "通用 关闭窗口 行为 最小化 托盘 退出 询问 beta 提示 免责",
  interconnect: "设备互联 远程管理 延迟测试 带宽测试 远程",
  maintenance: "数据维护 清除 临时隧道 清理 缓存 应用日志 txt 解析记录 重置 列宽",
};

/** 关闭窗口行为摘要文案 */
function closeActionLabel(action: CloseAction): string {
  switch (action) {
    case "minimize":
      return "最小化到托盘";
    case "exit":
      return "直接退出";
    default:
      return "每次询问";
  }
}

export interface SettingsProps {
  /** 是否正在下载更新 */
  isDownloading: boolean;
  /** 下载进度 0-100 */
  downloadProgress: number;
  /** 安装包是否已下载完成 */
  downloaded: boolean;
  /** 下载完成的安装包路径 */
  installerPath: string | null;
  /** 下载更新（由 App 层统一管理） */
  onUpdate: () => void;
  /** 安装更新（由 App 层统一管理） */
  onInstall: () => void;
}

export function Settings({
  isDownloading,
  downloadProgress,
  downloaded,
  installerPath: _installerPath,
  onUpdate,
  onInstall,
}: SettingsProps) {
  const isMacOS =
    typeof navigator !== "undefined" &&
    navigator.platform.toUpperCase().indexOf("MAC") >= 0;
  const isWindows =
    typeof navigator !== "undefined" &&
    navigator.platform.toUpperCase().indexOf("WIN") >= 0;

  const {
    followSystem,
    setFollowSystem,
    theme,
    setTheme,
    isViewTransitionRef,
  } = useTheme();

  const {
    backgroundImage,
    isSelectingImage,
    overlayOpacity,
    setOverlayOpacity,
    blur,
    setBlur,
    handleSelectBackgroundImage,
    handleClearBackgroundImage,
  } = useBackgroundImage();

  const [showTitleBar, setShowTitleBar] = useState<boolean>(() =>
    getInitialShowTitleBar(),
  );
  const [effectType, setEffectType] = useState<EffectType>(() =>
    getInitialEffectType(),
  );
  const [videoStartSound, setVideoStartSound] = useState<boolean>(() =>
    getInitialVideoStartSound(),
  );
  const [videoVolume, setVideoVolume] = useState<number>(() =>
    getInitialVideoVolume(),
  );
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>(() =>
    getInitialSidebarMode(),
  );
  const [sidebarVisibilityOpen, setSidebarVisibilityOpen] = useState(false);

  // 手风琴展开状态：始终恰好一个分组展开（点击其他标题自动收起，点击已展开的保持不变）
  const [expandedSection, setExpandedSection] = useState<SettingsSectionId>(
    getInitialExpandedSection,
  );

  const toggleSection = useCallback((id: SettingsSectionId) => {
    setExpandedSection((prev) => {
      // 点击已展开的分组：保持展开（保证不多不少恰好一个）
      if (prev === id) return prev;
      localStorage.setItem(EXPANDED_SECTION_KEY, id);
      return id;
    });
  }, []);

  // ===== 搜索 =====
  const [searchTerm, setSearchTerm] = useState("");
  const isSearching = searchTerm.trim().length > 0;

  /** 搜索时只显示关键词匹配的分组（全部强制展开）；无匹配则显示空提示 */
  const sectionMatches = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    if (!term) return null;
    const result = new Set<SettingsSectionId>();
    for (const id of SETTINGS_SECTION_IDS) {
      if (SECTION_KEYWORDS[id].includes(term)) result.add(id);
    }
    return result;
  }, [searchTerm]);

  // 摘要数据：关闭行为（监听变更事件保持同步）
  const [closeAction, setCloseActionState] = useState<CloseAction>(() => getCloseAction());
  useEffect(() => {
    const handler = () => setCloseActionState(getCloseAction());
    window.addEventListener("closeActionChanged", handler);
    return () => window.removeEventListener("closeActionChanged", handler);
  }, []);

  // 摘要数据：设备互联开关（监听变更事件保持同步）
  const [interconnectOn, setInterconnectOn] = useState(() => getInterconnectEnabled());
  useEffect(() => {
    const handler = () => setInterconnectOn(getInterconnectEnabled());
    window.addEventListener("interconnectChanged", handler);
    return () => window.removeEventListener("interconnectChanged", handler);
  }, []);

  const [currentVersion, setCurrentVersion] = useState<string>("");
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [autoCheckEnabled, setAutoCheckEnabled] = useState(() =>
    updateService.getAutoCheckEnabled(),
  );

  useEffect(() => {
    updateService.getCurrentVersion().then(setCurrentVersion);
  }, []);

  useEffect(() => {
    localStorage.setItem("showTitleBar", showTitleBar.toString());
    window.dispatchEvent(new Event("titleBarVisibilityChanged"));
  }, [showTitleBar]);

  useEffect(() => {
    localStorage.setItem("effectType", effectType);
    window.dispatchEvent(new Event("effectTypeChanged"));
  }, [effectType]);

  useEffect(() => {
    localStorage.setItem("videoStartSound", videoStartSound.toString());
    window.dispatchEvent(new Event("videoStartSoundChanged"));
  }, [videoStartSound]);

  useEffect(() => {
    localStorage.setItem("videoVolume", videoVolume.toString());
    window.dispatchEvent(new Event("videoVolumeChanged"));
  }, [videoVolume]);

  const handleSidebarModeChange = useCallback(
    (newMode: SidebarMode) => {
      setSidebarMode(newMode);
      localStorage.setItem("sidebarMode", newMode);
      window.dispatchEvent(new Event("sidebarModeChanged"));

      if (
        (newMode === "floating" || newMode === "floating_fixed") &&
        !showTitleBar
      ) {
        setShowTitleBar(true);
        localStorage.setItem("showTitleBar", "true");
        window.dispatchEvent(new Event("titleBarVisibilityChanged"));
      }
    },
    [showTitleBar],
  );

  useEffect(() => {
    localStorage.setItem("sidebarMode", sidebarMode);
    window.dispatchEvent(new Event("sidebarModeChanged"));
  }, [sidebarMode]);

  const handleCheckUpdate = useCallback(async () => {
    setCheckingUpdate(true);
    // 手动检查更新：上报开始事件（确认为真实用户意图）
    reportUsageIfLoggedIn("update_check_start", { auto: false });
    try {
      const result = await updateService.checkUpdate();
      // 检查成功（API 返回 = 确认为真实结果）
      reportUsageIfLoggedIn("update_check_success", { auto: false, available: result.available });
      if (result.available) {
        // 发现新版本
        reportUsageIfLoggedIn("update_available", {
          auto: false,
          version: result.version || null,
          mandatory: !!result.mandatory,
        });
        // 发现新版本：设置 updateInfo 触发 UpdateDialog 弹出，不显示 toast
        setUpdateInfo({
          version: result.version || "",
          date: result.date,
          body: result.body,
          mandatory: result.mandatory,
        });
        // 弹出更新对话框
        reportUsageIfLoggedIn("update_dialog_open", {
          version: result.version || null,
          mandatory: !!result.mandatory,
        });
      } else {
        setUpdateInfo(null);
        toast.success("当前已是最新版本");
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "检查更新失败";
      // 检查失败（确认为真实失败）
      reportUsageIfLoggedIn("update_check_failure", { auto: false, reason: errorMsg });
      toast.error(errorMsg, {
        action: {
          label: "手动检查",
          onClick: () => {
            void openUrl(updateService.getReleaseUrl());
          },
        },
      });
    } finally {
      setCheckingUpdate(false);
    }
  }, []);

  const handleAutoCheckChange = useCallback((enabled: boolean) => {
    setAutoCheckEnabled(enabled);
    updateService.setAutoCheckEnabled(enabled);
  }, []);

  // 关闭更新对话框：仅关闭弹窗，保留 downloaded 状态以便侧边栏/UpdateSection 继续显示"立即更新"
  const handleCloseUpdateDialog = useCallback(() => {
    setUpdateInfo(null);
  }, []);

  return (
    <div className="flex flex-col h-full gap-4">
      <div className="flex items-center justify-between gap-4">
        <h1 className="shrink-0 text-xl font-medium text-foreground">设置</h1>
        {/* 设置搜索：按分组关键词过滤定位，清空恢复手风琴 */}
        <div className="relative w-64 max-w-full">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="搜索设置…"
            className="h-8 w-full rounded-lg border border-border/50 bg-muted/30 pl-8 pr-7 text-xs text-foreground outline-none transition-colors placeholder:text-muted-foreground/70 focus:border-primary/50 focus:bg-background"
          />
          {isSearching && (
            <button
              type="button"
              onClick={() => setSearchTerm("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 cursor-pointer rounded-full p-0.5 text-muted-foreground transition-colors hover:text-foreground"
              aria-label="清空搜索"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto visible-scrollbar space-y-6">
        {/* 搜索无结果提示 */}
        {isSearching && sectionMatches?.size === 0 && (
          <div className="flex h-32 flex-col items-center justify-center text-center text-muted-foreground">
            <Search className="mb-2 h-6 w-6 opacity-40" />
            <p className="text-sm">没有找到与「{searchTerm.trim()}」相关的设置</p>
          </div>
        )}

        {(!isSearching || sectionMatches?.has("appearance")) && (
        <SectionCard
          icon={<Palette className="h-4 w-4" />}
          title="个性化"
          expanded={expandedSection === "appearance"}
          onToggle={() => toggleSection("appearance")}
          searching={isSearching}
          summary={
            followSystem ? "跟随系统" : theme === "dark" ? "深色模式" : "浅色模式"
          }
        >
          <AppearanceSection
            isMacOS={isMacOS}
            isWindows={isWindows}
            followSystem={followSystem}
            setFollowSystem={setFollowSystem}
            theme={theme}
            setTheme={setTheme}
            isViewTransitionRef={isViewTransitionRef}
            showTitleBar={showTitleBar}
            setShowTitleBar={setShowTitleBar}
            backgroundImage={backgroundImage}
            isSelectingImage={isSelectingImage}
            overlayOpacity={overlayOpacity}
            setOverlayOpacity={setOverlayOpacity}
            blur={blur}
            setBlur={setBlur}
            effectType={effectType}
            setEffectType={setEffectType}
            videoStartSound={videoStartSound}
            setVideoStartSound={setVideoStartSound}
            videoVolume={videoVolume}
            setVideoVolume={setVideoVolume}
            sidebarMode={sidebarMode}
            setSidebarMode={handleSidebarModeChange}
            onOpenSidebarVisibility={() => setSidebarVisibilityOpen(true)}
            onSelectBackgroundImage={handleSelectBackgroundImage}
            onClearBackgroundImage={handleClearBackgroundImage}
          />
        </SectionCard>
        )}

        {(!isSearching || sectionMatches?.has("update")) && (
        <SectionCard
          icon={<Sparkles className="h-4 w-4" />}
          title="更新"
          expanded={expandedSection === "update"}
          onToggle={() => toggleSection("update")}
          searching={isSearching}
          badge={!!updateInfo || downloaded}
          summary={
            updateInfo
              ? `v${currentVersion} · 有新版 v${updateInfo.version}`
              : downloaded
                ? `v${currentVersion} · 待安装`
                : currentVersion
                  ? `v${currentVersion}`
                  : undefined
          }
        >
          <UpdateSection
            checkingUpdate={checkingUpdate}
            currentVersion={currentVersion}
            onCheckUpdate={handleCheckUpdate}
            updateInfo={updateInfo}
            onUpdate={onUpdate}
            onInstall={onInstall}
            isDownloading={isDownloading}
            downloaded={downloaded}
            downloadProgress={downloadProgress}
            autoCheckEnabled={autoCheckEnabled}
            onAutoCheckChange={handleAutoCheckChange}
          />
        </SectionCard>
        )}

        {(!isSearching || sectionMatches?.has("general")) && (
        <SectionCard
          icon={<Settings2 className="h-4 w-4" />}
          title="通用"
          expanded={expandedSection === "general"}
          onToggle={() => toggleSection("general")}
          searching={isSearching}
          summary={`关闭时${closeActionLabel(closeAction)}`}
        >
          <GeneralSection />
        </SectionCard>
        )}

        {(!isSearching || sectionMatches?.has("interconnect")) && (
        <SectionCard
          icon={<MonitorSmartphone className="h-4 w-4" />}
          title="设备互联"
          expanded={expandedSection === "interconnect"}
          onToggle={() => toggleSection("interconnect")}
          searching={isSearching}
          summary={interconnectOn ? "已开启" : "已关闭"}
        >
          <InterconnectSection />
        </SectionCard>
        )}

        {(!isSearching || sectionMatches?.has("maintenance")) && (
        <SectionCard
          icon={<Trash2 className="h-4 w-4" />}
          title="数据维护"
          expanded={expandedSection === "maintenance"}
          onToggle={() => toggleSection("maintenance")}
          searching={isSearching}
        >
          <MaintenanceSection />
        </SectionCard>
        )}
      </div>

      <UpdateDialog
        isOpen={updateInfo !== null}
        onClose={handleCloseUpdateDialog}
        onUpdate={onUpdate}
        onInstall={onInstall}
        version={updateInfo?.version || ""}
        date={updateInfo?.date}
        body={updateInfo?.body}
        isDownloading={isDownloading}
        downloaded={downloaded}
        downloadProgress={downloadProgress}
      />
      <SidebarVisibilityDialog
        open={sidebarVisibilityOpen}
        onOpenChange={setSidebarVisibilityOpen}
      />
    </div>
  );
}
