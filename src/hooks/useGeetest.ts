/**
 * 极验 GT4 验证码 Hook
 *
 * 封装 GT4 SDK 的加载、初始化与验证流程。
 * 使用 bind 模式：调用 verify() 时弹出验证码窗口，用户完成后返回验证结果。
 *
 * 用法：
 *   const { verify, ready } = useGeetest();
 *   const result = await verify(); // null 表示用户取消或失败
 */
import { useState, useEffect, useRef, useCallback } from "react";
import { getGeetestConfig, type GeetestValidation } from "@/services/backendApi";

const GT4_SCRIPT_URL = "https://static.geetest.com/v4/gt4.js";

// 极验 GT4 handler 类型（极验官方无 TS 类型，使用宽松定义）
interface GeetestHandler {
  onSuccess: (cb: () => void) => void;
  onError: (cb: () => void) => void;
  onClose: (cb: () => void) => void;
  offSuccess: (cb: () => void) => void;
  offError: (cb: () => void) => void;
  offClose: (cb: () => void) => void;
  showCaptcha: () => void;
  getValidate: () => GeetestValidation | null;
  reset: () => void;
}

interface GeetestConfig {
  captchaId: string;
  product: "bind" | "float" | "embed" | "popup";
  language?: string;
}

declare global {
  interface Window {
    initGeetest4?: (
      config: GeetestConfig,
      cb: (handler: GeetestHandler) => void,
    ) => void;
  }
}

// 单例：脚本加载 Promise（全应用共享一次加载）
let scriptPromise: Promise<void> | null = null;

/**
 * 提升极验 GT4 弹窗的 z-index，确保覆盖在 Radix Dialog 之上
 *
 * 极验弹窗 DOM 结构：
 *   .geetest_mask       半透明遮罩
 *   .geetest_panel      弹窗面板
 *   .geetest_popup      弹窗内容
 *   .geetest_popup_ghost 箭头
 *
 * Radix Dialog 默认 z-50，IssueSubmitDialog 用了 z-[10000]，
 * 这里将极验弹窗提升到 z-[100000] 确保可点击。
 *
 * 关键点：Radix Dialog 在 modal 模式下会给 body 及其直接子元素设置
 * `pointer-events: none`（仅 DialogContent 自身设为 auto）。
 * 极验弹窗挂在 body 下但不在 Dialog 内，即使 z-index 再高也无法点击。
 * 因此必须同时给极验弹窗元素强制设置 `pointer-events: auto`。
 *
 * 实现说明：极验 showCaptcha() 后 DOM 是异步渲染的，单次 requestAnimationFrame
 * 时机可能过早导致样式未应用。这里用 MutationObserver 持续监听极验弹窗的插入，
 * 确保任何渲染时机都能应用样式；同时兼容已渲染的元素。
 */
const GEETEST_SELECTORS = [
  ".geetest_mask",
  ".geetest_panel",
  ".geetest_popup",
  ".geetest_popup_ghost",
  ".geetest_widget",
  ".geetest_canvas",
];

// 保存 MutationObserver 实例，便于验证完成后断开
let geetestObserver: MutationObserver | null = null;

function applyGeetestStyles(): void {
  for (const sel of GEETEST_SELECTORS) {
    document.querySelectorAll<HTMLElement>(sel).forEach((el) => {
      el.style.setProperty("z-index", "100000", "important");
      // 强制启用指针事件，突破 Radix Dialog modal 锁定
      el.style.setProperty("pointer-events", "auto", "important");
    });
  }
}

function elevateGeetestZIndex(): void {
  // 1. 立即处理已渲染的元素
  applyGeetestStyles();
  // 2. 用 MutationObserver 监听后续异步插入的极验弹窗元素
  if (geetestObserver) {
    geetestObserver.disconnect();
  }
  geetestObserver = new MutationObserver(() => {
    applyGeetestStyles();
  });
  geetestObserver.observe(document.body, {
    childList: true,
    subtree: true,
  });
  // 3. 兜底：几个延迟重试，覆盖极验内部不同延迟的渲染时机
  requestAnimationFrame(applyGeetestStyles);
  setTimeout(applyGeetestStyles, 100);
  setTimeout(applyGeetestStyles, 300);
}

/** 恢复极验弹窗 z-index 和 pointer-events（验证完成后调用） */
function restoreGeetestZIndex(): void {
  // 断开 observer，避免验证关闭后仍重复应用样式
  if (geetestObserver) {
    geetestObserver.disconnect();
    geetestObserver = null;
  }
  for (const sel of GEETEST_SELECTORS) {
    document.querySelectorAll<HTMLElement>(sel).forEach((el) => {
      el.style.removeProperty("z-index");
      el.style.removeProperty("pointer-events");
    });
  }
}

function loadGt4Script(): Promise<void> {
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise<void>((resolve, reject) => {
    if (window.initGeetest4) {
      resolve();
      return;
    }
    // 检查是否已有同名 script 标签
    const existing = document.querySelector(
      `script[src="${GT4_SCRIPT_URL}"]`,
    );
    if (existing) {
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () =>
        reject(new Error("极验脚本加载失败")),
      );
      return;
    }
    const script = document.createElement("script");
    script.src = GT4_SCRIPT_URL;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("极验脚本加载失败"));
    document.head.appendChild(script);
  });
  return scriptPromise;
}

export interface UseGeetestResult {
  /** 是否已初始化就绪 */
  ready: boolean;
  /** 触发验证码弹窗，返回验证结果（null 表示取消或失败） */
  verify: () => Promise<GeetestValidation | null>;
  /** 重置验证码状态 */
  reset: () => void;
}

/**
 * 极验 GT4 验证码 Hook
 * 自动加载脚本、获取配置、初始化验证码实例
 */
export function useGeetest(enabled = true): UseGeetestResult {
  const [ready, setReady] = useState(false);
  const handlerRef = useRef<GeetestHandler | null>(null);

  useEffect(() => {
    if (!enabled) {
      handlerRef.current = null;
      setReady(false);
      return;
    }

    let cancelled = false;

    (async () => {
      try {
        const config = await getGeetestConfig();
        if (cancelled || !config.enabled || !config.captcha_id) {
          return;
        }

        await loadGt4Script();
        if (cancelled || !window.initGeetest4) return;

        window.initGeetest4(
          {
            captchaId: config.captcha_id,
            product: "bind",
            language: "zho",
          },
          (handler) => {
            if (cancelled) return;
            handlerRef.current = handler;
            setReady(true);
          },
        );
      } catch {
        // 初始化失败，ready 保持 false，verify 时会提示
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [enabled]);

  const verify = useCallback((): Promise<GeetestValidation | null> => {
    const handler = handlerRef.current;
    if (!handler) {
      return Promise.reject(new Error("验证码未就绪，请稍后重试"));
    }

    return new Promise<GeetestValidation | null>((resolve) => {
      let settled = false;
      const finish = (val: GeetestValidation | null) => {
        if (settled) return;
        settled = true;
        try {
          handler.offSuccess?.(onSuccess);
          handler.offError?.(onError);
          handler.offClose?.(onClose);
        } catch {
          // ignore
        }
        // 清理 z-index 提升样式
        restoreGeetestZIndex();
        resolve(val);
      };
      const onSuccess = () => {
        const result = handler.getValidate();
        finish(result || null);
      };
      const onError = () => finish(null);
      const onClose = () => finish(null);

      handler.onSuccess(onSuccess);
      handler.onError(onError);
      handler.onClose(onClose);

      try {
        handler.showCaptcha();
        // 提升极验弹窗 z-index，确保覆盖在 Radix Dialog 之上
        // Radix Dialog 默认 z-50，部分自定义 Dialog 可能 z-[10000]，这里用更高值
        elevateGeetestZIndex();
      } catch {
        finish(null);
      }
    });
  }, []);

  const reset = useCallback(() => {
    try {
      handlerRef.current?.reset?.();
    } catch {
      // ignore
    }
  }, []);

  return { ready, verify, reset };
}
