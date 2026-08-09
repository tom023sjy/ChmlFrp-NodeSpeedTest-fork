import { useState, useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import {
  Settings as SettingsIcon,
  LogIn,
  LogOut,
  User,
  Network,
  RotateCcw,
  Shield,
  ShieldCheck,
  Globe,
  KeyRound,
  Info,
  MonitorSmartphone,
} from "lucide-react";
import { BetaTag } from "@/components/ui/beta-tag";
import {
  loginWithProxyToken,
  logoutWithProxyToken,
  saveStoredUser,
  type StoredUser,
} from "@/services/api";
import {
  generateSessionId,
  buildLoginUrl,
  startLoginPolling,
  reportUsage,
} from "@/services/backendApi";
import { openUrl } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";
import type { SidebarMode } from "@/lib/settings-utils";
import { getInitialEffectType, type EffectType } from "@/lib/settings-utils";

/** Beta 功能悬浮提示内容由统一组件 BetaTag 提供 */

interface SidebarProps {
  activeTab: string;
  onTabChange: (tab: string) => void;
  user: StoredUser | null;
  onUserChange: (user: StoredUser | null) => void;
  collapsed?: boolean;
  onCollapseChange?: (collapsed: boolean) => void;
  collapsedWidth?: number;
  mode?: SidebarMode;
  disabled?: boolean;
  /** 是否有已下载完成的待安装更新 */
  hasPendingUpdate?: boolean;
  /** 点击侧边栏"立即更新"按钮时触发安装 */
  onInstallUpdate?: () => void;
}

export function Sidebar({
  activeTab,
  onTabChange,
  user,
  onUserChange,
  collapsed: collapsedProp,
  onCollapseChange: onCollapseChangeProp,
  collapsedWidth,
  mode = "classic",
  disabled = false,
  hasPendingUpdate = false,
  onInstallUpdate,
}: SidebarProps) {
  const [showTitleBar, setShowTitleBar] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    const isMacOS = navigator.platform.toUpperCase().indexOf("MAC") >= 0;
    const stored = localStorage.getItem("showTitleBar");
    if (stored === null) return !isMacOS;
    return stored === "true";
  });

  const [effectType, setEffectType] = useState<EffectType>(() =>
    getInitialEffectType(),
  );

  useEffect(() => {
    const handleTitleBarVisibilityChange = () => {
      const stored = localStorage.getItem("showTitleBar");
      setShowTitleBar(stored !== "false");
    };

    const handleEffectTypeChange = () => {
      const stored = localStorage.getItem("effectType");
      if (
        stored === "frosted" ||
        stored === "translucent" ||
        stored === "none"
      ) {
        setEffectType(stored);
      }
    };

    window.addEventListener(
      "titleBarVisibilityChanged",
      handleTitleBarVisibilityChange,
    );
    window.addEventListener("effectTypeChanged", handleEffectTypeChange);
    return () => {
      window.removeEventListener(
        "titleBarVisibilityChanged",
        handleTitleBarVisibilityChange,
      );
      window.removeEventListener("effectTypeChanged", handleEffectTypeChange);
    };
  }, []);

  const [rememberMe] = useState(true);
  const [, setLoading] = useState(false);
  const [polling, setPolling] = useState(false);
  const [remainingSeconds, setRemainingSeconds] = useState<number>(0);
  const [, setAuthMessage] = useState(
    "将在浏览器中打开授权页面",
  );
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  /** 标记用户主动取消登录（区别于轮询失败） */
  const cancelRequestedRef = useRef(false);

  /** 格式化倒计时为 mm:ss */
  const formatCountdown = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  };

  // 点击外部关闭用户菜单
  useEffect(() => {
    if (!userMenuOpen) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (
        userMenuRef.current &&
        !userMenuRef.current.contains(event.target as Node)
      ) {
        setUserMenuOpen(false);
        if (mode !== "classic") {
          setCollapsedState(true);
        }
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [userMenuOpen, mode]);

  const stopPolling = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setPolling(false);
    setRemainingSeconds(0);
  };

  const resetLoginFlow = () => {
    stopPolling();
    setLoading(false);
    setAuthMessage("将在浏览器中打开授权页面");
    setRemainingSeconds(0);
  };

  const finishLogin = async (
    proxyToken: string,
    user: {
      username: string;
      usergroup: string;
      userimg?: string | null;
      usertoken?: string;
      email?: string | null;
      phone?: string | null;
    },
    proxyExpiresAt?: string | null,
  ) => {
    const authedUser = await loginWithProxyToken(proxyToken, user, proxyExpiresAt);
    onUserChange(authedUser);
    if (rememberMe) {
      saveStoredUser(authedUser);
    }
    stopPolling();
    setUserMenuOpen(false);
    resetLoginFlow();
    // 上报登录事件
    reportUsage({ eventType: "login" }).catch(() => {});
  };

  /** 用户主动取消登录轮询 */
  const cancelLoginPolling = () => {
    cancelRequestedRef.current = true;
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    stopPolling();
    setLoading(false);
    toast.info("已取消登录");
  };

  const startBrowserLogin = async () => {
    stopPolling();
    cancelRequestedRef.current = false;
    setLoading(true);
    setAuthMessage("正在准备授权页面...");

    try {
      const sessionId = generateSessionId();
      const loginUrl = buildLoginUrl(sessionId);

      // 在系统浏览器中打开后端登录页（含极验验证码 + qzhua OAuth）
      await openUrl(loginUrl);
      setAuthMessage("请在浏览器中完成验证码与授权");
      setPolling(true);
      toast.info("已在浏览器中打开登录页面，请完成授权");

      // 轮询后端 /auth/status 获取登录结果
      const controller = new AbortController();
      abortControllerRef.current = controller;

      const result = await startLoginPolling(sessionId, {
        intervalMs: 2000,
        timeoutMs: 5 * 60 * 1000, // 5 分钟超时
        signal: controller.signal,
        onTick: (seconds) => setRemainingSeconds(seconds),
      });

      await finishLogin(
        result.proxyToken,
        result.user,
        result.proxyExpiresAt ?? null,
      );
    } catch (err) {
      stopPolling();
      // 用户主动取消时不显示错误提示（cancelLoginPolling 已显示 info）
      if (cancelRequestedRef.current) {
        cancelRequestedRef.current = false;
      } else {
        toast.error(err instanceof Error ? err.message : "登录失败");
      }
    } finally {
      setLoading(false);
    }
  };

  const menuItems: {
    id: string;
    label: string;
    icon: typeof Network;
    beta?: boolean;
    betaTitle?: string;
  }[] = [
    { id: "node-test", label: "节点推荐", icon: Network },
    { id: "dns-credentials", label: "DNS 服务商", icon: KeyRound },
    { id: "dns-failover", label: "DNS 容灾", icon: Shield },
    {
      id: "dns-management",
      label: "DDNS 解析",
      icon: Globe,
      beta: true,
      betaTitle: "Beta 测试功能：此功能仍在测试阶段，可能出现数据异常、功能不稳定等问题，开发者不承担任何由此造成的损失或责任，请谨慎使用。",
    },
    {
      id: "ssl-certs",
      label: "SSL 证书",
      icon: ShieldCheck,
      beta: true,
      betaTitle: "Beta 测试功能：此功能仍在测试阶段，可能出现数据异常、功能不稳定等问题，开发者不承担任何由此造成的损失或责任，请谨慎使用。",
    },
    {
      id: "device-management",
      label: "设备管理",
      icon: MonitorSmartphone,
      beta: true,
      betaTitle: "Beta 测试功能：此功能仍在测试阶段，可能出现数据异常、功能不稳定等问题，开发者不承担任何由此造成的损失或责任，请谨慎使用。",
    },
    { id: "settings", label: "设置", icon: SettingsIcon },
    { id: "about", label: "关于", icon: Info },
  ];

  const handleMenuClick = (itemId: string) => {
    if (disabled) return;
    onTabChange(itemId);
  };

  const isMacOS =
    typeof navigator !== "undefined" &&
    navigator.platform.toUpperCase().indexOf("MAC") >= 0;

  const [internalCollapsed, setInternalCollapsed] = useState<boolean>(false);
  const isControlled = typeof collapsedProp !== "undefined";
  const collapsed = isControlled ? !!collapsedProp : internalCollapsed;
  const setCollapsedState = (v: boolean) => {
    if (isControlled) {
      onCollapseChangeProp?.(v);
    } else {
      setInternalCollapsed(v);
    }
  };

  const leaveTimerRef = useRef<number | null>(null);
  const animationTimeoutRef = useRef<number | null>(null);

  const handleMouseEnter = () => {
    if (mode !== "floating") return;
    if (leaveTimerRef.current) {
      clearTimeout(leaveTimerRef.current);
      leaveTimerRef.current = null;
    }
    if (animationTimeoutRef.current) {
      clearTimeout(animationTimeoutRef.current);
    }
    setCollapsedState(false);
    animationTimeoutRef.current = window.setTimeout(() => {
      animationTimeoutRef.current = null;
    }, 300);
  };

  const handleMouseLeave = () => {
    if (mode !== "floating" && mode !== "floating_fixed") return;
    if (leaveTimerRef.current) {
      clearTimeout(leaveTimerRef.current);
    }
    if (animationTimeoutRef.current) {
      clearTimeout(animationTimeoutRef.current);
    }
    leaveTimerRef.current = window.setTimeout(() => {
      setCollapsedState(true);
      setUserMenuOpen(false);
      leaveTimerRef.current = null;
      animationTimeoutRef.current = window.setTimeout(() => {
        animationTimeoutRef.current = null;
      }, 450);
    }, 200);
  };

  useEffect(() => {
    return () => {
      if (leaveTimerRef.current) {
        clearTimeout(leaveTimerRef.current);
        leaveTimerRef.current = null;
      }
      if (animationTimeoutRef.current) {
        clearTimeout(animationTimeoutRef.current);
        animationTimeoutRef.current = null;
      }
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
    };
  }, []);

  if (mode === "classic") {
    const isFrosted = effectType === "frosted";
    return (
      <div
        className={cn(
          "w-56 flex flex-col h-full relative bg-card",
          isFrosted && "backdrop-blur-md",
        )}
      >
        {isMacOS && !showTitleBar ? (
          <div
            data-tauri-drag-region
            className="h-8 flex-shrink-0 flex items-start pt-3 pl-5"
          />
        ) : null}
        <div
          className={cn(
            "px-6 pb-6",
            isMacOS && !showTitleBar ? "pt-4" : "pt-8",
          )}
          {...(isMacOS && !showTitleBar && { "data-tauri-drag-region": true })}
        >
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-primary to-primary/80 flex items-center justify-center shadow-md">
              <span className="text-primary-foreground font-bold text-base">
                CR
              </span>
            </div>
            <div>
              <h1 className="text-lg font-bold text-foreground tracking-tight">
                社区工具箱
              </h1>
              <p className="text-[10px] text-muted-foreground tracking-wide font-medium">
                ChmlFrp社区
              </p>
            </div>
          </div>
        </div>

        <nav className="flex-1 px-3 py-2">
          <ul className="space-y-1">
            {menuItems.map((item) => {
              const Icon = item.icon;
              const isActive = activeTab === item.id;
              return (
                <li key={item.id}>
                  <button
                    onClick={() => handleMenuClick(item.id)}
                    disabled={disabled}
                    className={cn(
                      "w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl transition-all duration-200 text-sm font-medium group relative overflow-hidden",
                      disabled && "opacity-50 cursor-not-allowed",
                      isActive
                        ? "bg-primary/10 text-primary shadow-sm"
                        : "text-muted-foreground hover:text-foreground hover:bg-muted/50",
                      !disabled && !isActive && "hover:text-foreground hover:bg-muted/50",
                    )}
                  >
                    {isActive && (
                      <div className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-1/2 bg-primary rounded-r-full" />
                    )}
                    <Icon
                      className={cn(
                        "w-[18px] h-[18px] transition-transform duration-200",
                        isActive ? "text-primary" : !disabled && "group-hover:scale-110",
                      )}
                    />
                    <span className="tracking-tight">{item.label}</span>
                    {item.beta && item.betaTitle && (
                      <BetaTag
                        betaTitle={item.betaTitle}
                        className="ml-auto"
                      />
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>

        {hasPendingUpdate && onInstallUpdate && (
          <div className="px-3 pb-2">
            <button
              onClick={onInstallUpdate}
              className="w-full flex items-center gap-2 px-3 py-2 rounded-xl bg-primary/10 hover:bg-primary/20 text-primary text-xs font-medium transition-all duration-200 group border border-primary/20"
              title="退出时也会自动安装"
            >
              <RotateCcw className="w-3.5 h-3.5 group-hover:rotate-180 transition-transform duration-500" />
              <span>立即更新</span>
              <span className="ml-auto w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
            </button>
          </div>
        )}

        <div
          className="p-4 border-t border-border/30 relative"
          ref={userMenuRef}
        >
          <button
            className="w-full p-2 text-left hover:bg-muted/50 transition-all duration-200 flex items-center gap-3 rounded-xl group relative"
            onClick={() => {
              if (user) {
                setUserMenuOpen((v) => !v);
              } else if (polling) {
                cancelLoginPolling();
              } else {
                void startBrowserLogin();
              }
            }}
          >
            {user?.userimg ? (
              <img
                src={user.userimg}
                alt={user.username}
                className="h-10 w-10 rounded-xl object-cover ring-2 ring-primary/10 group-hover:ring-primary/20 transition-all"
              />
            ) : polling ? (
              <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-primary/10 to-primary/5 flex items-center justify-center shadow-sm">
                <span className="h-5 w-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
              </div>
            ) : (
              <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-muted to-muted/80 flex items-center justify-center shadow-sm group-hover:shadow transition-shadow">
                <LogIn className="w-5 h-5 text-muted-foreground" />
              </div>
            )}
            <div className="flex-1 min-w-0">
              <h1 className="text-sm font-semibold text-foreground truncate">
                {user?.username ?? "未登录"}
              </h1>
              <p className="text-[11px] text-muted-foreground truncate">
                {user
                  ? user.usergroup
                  : polling
                    ? `等待授权中... ${formatCountdown(remainingSeconds)}`
                    : "点击登录"}
              </p>
            </div>
          </button>

          {user && userMenuOpen && (
            <div
              className={cn(
                "absolute left-4 right-4 bottom-[calc(100%+8px)] rounded-xl border border-border/40 shadow-xl z-10 overflow-hidden animate-in fade-in slide-in-from-bottom-2 duration-200 bg-card",
                effectType === "frosted" && "backdrop-blur-md",
              )}
            >
              <div className="p-1">
                <button
                  className="w-full text-left text-sm text-foreground px-3 py-2 rounded-lg hover:bg-destructive/10 hover:text-destructive transition-all duration-200 flex items-center gap-2 group"
                  onClick={() => {
                    onUserChange(null);
                    setUserMenuOpen(false);
                    logoutWithProxyToken();
                    onTabChange("node-test");
                  }}
                >
                  <LogOut className="w-4 h-4 transition-transform group-hover:translate-x-0.5" />
                  <span className="font-medium">退出登录</span>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  const isFrosted = effectType === "frosted";
  return (
    <>
      <div
        className={cn(
          "relative h-full overflow-hidden animate-in slide-in-from-left-2 duration-300 floating-sidebar bg-card",
          isFrosted && "backdrop-blur-md",
        )}
        style={{
          borderRadius: "18px",
          transition: "width 0.5s cubic-bezier(0.32, 0.72, 0, 1)",
          width: collapsed ? `${collapsedWidth ?? 66}px` : "224px",
        }}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        <div
          className="absolute inset-0 bg-gradient-to-r from-sidebar/20 via-sidebar/10 to-transparent pointer-events-none"
          style={{ borderRadius: "18px" }}
        />

        <div
          className="relative flex flex-col h-full z-10"
          style={{ borderRadius: "18px" }}
        >
          {isMacOS && !showTitleBar ? (
            <div
              data-tauri-drag-region
              className="h-8 flex-shrink-0 flex items-start pt-3 pl-5"
            />
          ) : null}

          {/* 头部 Logo 区域 */}
          <div
            className="relative flex items-center overflow-hidden"
            style={{
              paddingBottom: "24px",
              paddingTop: isMacOS && !showTitleBar ? "16px" : "32px",
              paddingLeft: collapsed ? "15px" : "24px",
              gap: collapsed ? "0px" : "12px",
              transition: "all 0.5s cubic-bezier(0.32, 0.72, 0, 1)",
            }}
            {...(isMacOS &&
              !showTitleBar && {
                "data-tauri-drag-region": true,
              })}
          >
            <div className="flex-shrink-0 flex items-center justify-center">
              <div className="h-9 w-9 rounded-xl bg-gradient-to-br from-primary to-primary/80 flex items-center justify-center shadow-md">
                <span className="text-primary-foreground font-bold text-sm">
                  CR
                </span>
              </div>
            </div>
            <div
              className="whitespace-nowrap"
              style={{
                opacity: collapsed ? 0 : 1,
                transform: collapsed ? "translateX(-10px)" : "translateX(0)",
                transition: "all 0.5s cubic-bezier(0.32, 0.72, 0, 1)",
              }}
            >
              <h1 className="text-lg font-bold text-foreground tracking-tight">
                社区工具箱
              </h1>
              <p className="text-[10px] text-muted-foreground tracking-wide font-medium">
                ChmlFrp社区
              </p>
            </div>
          </div>

          <nav className="relative flex-1 px-3 py-2">
            <ul className="space-y-1">
              {menuItems.map((item) => {
                const Icon = item.icon;
                const isActive = activeTab === item.id;
                return (
                  <li key={item.id}>
                    <button
                      onClick={() => handleMenuClick(item.id)}
                      disabled={disabled}
                      className={cn(
                        "w-full flex items-center rounded-xl transition-all duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] group relative overflow-hidden text-sm font-medium",
                        disabled && "opacity-50 cursor-not-allowed",
                        isActive
                          ? "bg-primary/10 text-primary shadow-sm"
                          : "text-muted-foreground",
                        !disabled && !isActive && "hover:text-foreground hover:bg-muted/50",
                      )}
                      style={{
                        height: "42px",
                        paddingLeft: collapsed ? "12px" : "14px",
                        paddingRight: "14px",
                        paddingTop: "10px",
                        paddingBottom: "10px",
                        gap: collapsed ? "0px" : "12px",
                        justifyContent: "flex-start",
                      }}
                      title={collapsed ? (item.beta ? `${item.label}（Beta）` : item.label) : undefined}
                    >
                      {isActive && (
                        <div
                          className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-1/2 bg-primary rounded-r-full transition-opacity duration-300"
                          style={{
                            opacity: collapsed ? 0 : 1,
                          }}
                        />
                      )}

                      <Icon
                        className={cn(
                          "w-[18px] h-[18px] transition-transform duration-200 flex-shrink-0",
                          isActive ? "text-primary" : "group-hover:scale-110",
                        )}
                      />

                      <span
                        className="tracking-tight whitespace-nowrap overflow-hidden"
                        style={{
                          opacity: collapsed ? 0 : 1,
                          transform: collapsed
                            ? "translateX(-10px)"
                            : "translateX(0)",
                          transition: "all 0.5s cubic-bezier(0.32,0.72,0,1)",
                        }}
                      >
                        {item.label}
                      </span>
                      {item.beta && !collapsed && item.betaTitle && (
                        <BetaTag
                          betaTitle={item.betaTitle}
                          className="ml-auto"
                        />
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>

          {hasPendingUpdate && onInstallUpdate && (
            <div
              className="px-3 pb-2"
              style={{
                transition: "all 0.5s cubic-bezier(0.32, 0.72, 0, 1)",
              }}
            >
              <button
                onClick={onInstallUpdate}
                className={cn(
                  "w-full flex items-center rounded-xl bg-primary/10 hover:bg-primary/20 text-primary text-xs font-medium transition-all duration-200 group border border-primary/20",
                  collapsed ? "justify-center px-2 py-2" : "gap-2 px-3 py-2",
                )}
                title={collapsed ? "立即更新（退出时也会自动安装）" : "退出时也会自动安装"}
              >
                <RotateCcw className="w-3.5 h-3.5 group-hover:rotate-180 transition-transform duration-500 flex-shrink-0" />
                <span
                  className="tracking-tight whitespace-nowrap overflow-hidden"
                  style={{
                    opacity: collapsed ? 0 : 1,
                    transform: collapsed ? "translateX(-10px)" : "translateX(0)",
                    transition: "all 0.5s cubic-bezier(0.32, 0.72, 0, 1)",
                  }}
                >
                  立即更新
                </span>
                {!collapsed && (
                  <span className="ml-auto w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
                )}
              </button>
            </div>
          )}

          <div
            className="relative border-t border-sidebar-border/30"
            style={{
              padding: collapsed ? "12px 0" : "16px", // p-4 = 16px
              transition: "all 0.5s cubic-bezier(0.32, 0.72, 0, 1)",
            }}
            ref={userMenuRef}
          >
            <button
              className="w-full text-left hover:bg-muted/50 flex items-center rounded-xl group relative overflow-hidden"
              style={{
                height: "56px",
                padding: "8px",
                paddingLeft: collapsed ? "13px" : "8px", // Center 40px in 66px vs Standard padding
                gap: collapsed ? "0px" : "12px",
                justifyContent: "flex-start",
                transition: "all 0.5s cubic-bezier(0.32, 0.72, 0, 1)",
              }}
              onClick={() => {
                if (user) {
                  if (mode === "floating" || mode === "floating_fixed") {
                    if (userMenuOpen) {
                      setCollapsedState(true);
                    } else if (collapsed) {
                      setCollapsedState(false);
                    }
                  }
                  setUserMenuOpen((v) => !v);
                } else if (polling) {
                  cancelLoginPolling();
                } else {
                  void startBrowserLogin();
                }
              }}
            >
              <div className="flex-shrink-0 flex items-center justify-center">
                {user?.userimg ? (
                  <img
                    src={user.userimg}
                    alt={user.username}
                    className="h-10 w-10 rounded-xl object-cover ring-2 ring-primary/10 group-hover:ring-primary/20 transition-all"
                  />
                ) : polling ? (
                  <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-primary/10 to-primary/5 flex items-center justify-center shadow-sm">
                    <span className="h-5 w-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
                  </div>
                ) : (
                  <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-muted to-muted/80 flex items-center justify-center shadow-sm group-hover:shadow transition-shadow">
                    <LogIn className="w-5 h-5 text-muted-foreground" />
                  </div>
                )}
              </div>
              <div
                className="overflow-hidden whitespace-nowrap"
                style={{
                  opacity: collapsed ? 0 : 1,
                  transform: collapsed ? "translateX(-10px)" : "translateX(0)",
                  transition: "all 0.4s cubic-bezier(0.4, 0, 0.2, 1)",
                }}
              >
                <h1 className="text-sm font-semibold text-foreground truncate">
                  {user?.username ?? "未登录"}
                </h1>
                <p className="text-[11px] text-muted-foreground truncate">
                  {user
                    ? user.usergroup
                    : polling
                      ? `等待授权中... ${formatCountdown(remainingSeconds)}`
                      : "点击登录"}
                </p>
              </div>
            </button>

            {user && userMenuOpen && (
              <div
                className={cn(
                  "absolute left-3 right-3 bottom-full mb-2 rounded-2xl border border-border/40 shadow-2xl z-[100] overflow-hidden animate-in fade-in slide-in-from-bottom-2 duration-200 bg-card",
                  isFrosted && "backdrop-blur-md",
                )}
              >
                <div className="px-4 py-3 bg-foreground/[0.02] border-b border-border/30">
                  <div className="flex items-center gap-3">
                    {user.userimg ? (
                      <img
                        src={user.userimg}
                        alt={user.username}
                        className="h-10 w-10 rounded-lg object-cover ring-2 ring-foreground/10"
                      />
                    ) : (
                      <div className="h-10 w-10 rounded-lg bg-gradient-to-br from-foreground/90 to-foreground/70 flex items-center justify-center shadow-sm">
                        <User className="w-5 h-5 text-background" />
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <h3 className="text-sm font-semibold text-foreground truncate">
                        {user.username}
                      </h3>
                      <p className="text-[11px] text-muted-foreground truncate">
                        {user.usergroup}
                      </p>
                    </div>
                  </div>
                </div>

                <div className="p-1.5">
                  <button
                    className="w-full text-left text-sm text-foreground px-3 py-2.5 rounded-lg hover:bg-destructive/10 hover:text-destructive transition-all duration-200 flex items-center gap-2.5 group"
                    onClick={() => {
                      onUserChange(null);
                      setUserMenuOpen(false);
                      logoutWithProxyToken();
                      onTabChange("node-test");
                      if (mode === "floating" || mode === "floating_fixed") {
                        setCollapsedState(true);
                      }
                    }}
                  >
                    <LogOut className="w-4 h-4 transition-transform group-hover:translate-x-0.5" />
                    <span className="font-medium">退出登录</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
