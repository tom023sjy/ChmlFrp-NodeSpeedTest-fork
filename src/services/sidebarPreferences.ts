export const SIDEBAR_VISIBILITY_EVENT = "sidebarVisibilityChanged";
export const SIDEBAR_HIDDEN_ITEMS_KEY = "sidebarHiddenItems";
export const REQUIRED_SIDEBAR_ITEMS = new Set(["settings", "about"]);
export const CONFIGURABLE_SIDEBAR_ITEMS = [
  { id: "node-test", label: "节点推荐" },
  { id: "dns-credentials", label: "DNS 服务商" },
  { id: "dns-failover", label: "DNS 容灾" },
  { id: "dns-management", label: "DDNS 解析" },
  { id: "ssl-certs", label: "SSL 证书" },
  { id: "device-management", label: "设备管理" },
] as const;

export function normalizeHiddenSidebarItems(items: unknown): string[] {
  if (!Array.isArray(items)) return [];
  return [...new Set(items.filter(
    (item): item is string => typeof item === "string" && !REQUIRED_SIDEBAR_ITEMS.has(item),
  ))];
}

export function readHiddenSidebarItems(): string[] {
  if (typeof window === "undefined") return [];
  try {
    return normalizeHiddenSidebarItems(JSON.parse(localStorage.getItem(SIDEBAR_HIDDEN_ITEMS_KEY) || "[]"));
  } catch {
    return [];
  }
}

export function writeHiddenSidebarItems(items: string[]): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(SIDEBAR_HIDDEN_ITEMS_KEY, JSON.stringify(normalizeHiddenSidebarItems(items)));
  window.dispatchEvent(new Event(SIDEBAR_VISIBILITY_EVENT));
}

export function filterVisibleSidebarItems<T extends { id: string }>(items: T[], hidden: string[]): T[] {
  const hiddenItems = new Set(normalizeHiddenSidebarItems(hidden));
  return items.filter((item) => !hiddenItems.has(item.id));
}
