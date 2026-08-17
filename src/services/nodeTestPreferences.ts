export type StatisticMode = "max" | "avg" | "min";
export type StatisticTarget = "latency" | "speed";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const STATISTIC_KEYS: Record<StatisticTarget, string> = {
  latency: "nodeTestLatencyStatisticMode",
  speed: "nodeTestSpeedStatisticMode",
};

const DURATION_KEY = "nodeTestDurationSeconds";
export const NODE_TEST_PREFERENCES_CHANGED = "nodeTestPreferencesChanged";

function normalizeStoredDuration(value: number | undefined): number {
  if (value == null || !Number.isFinite(value)) return 15;
  return Math.max(5, Math.min(120, Math.trunc(value)));
}

function isStatisticMode(value: string | null): value is StatisticMode {
  return value === "max" || value === "avg" || value === "min";
}

export function getStoredStatisticMode(
  storage: StorageLike,
  target: StatisticTarget,
): StatisticMode {
  const value = storage.getItem(STATISTIC_KEYS[target]);
  return isStatisticMode(value) ? value : target === "latency" ? "avg" : "max";
}

export function setStoredStatisticMode(
  storage: StorageLike,
  target: StatisticTarget,
  mode: StatisticMode,
): void {
  storage.setItem(STATISTIC_KEYS[target], mode);
}

export function getStoredDurationSeconds(storage: StorageLike): number {
  const stored = storage.getItem(DURATION_KEY);
  return normalizeStoredDuration(stored == null ? undefined : Number(stored));
}

export function setStoredDurationSeconds(
  storage: StorageLike,
  value: number,
): number {
  const normalized = normalizeStoredDuration(value);
  storage.setItem(DURATION_KEY, normalized.toString());
  return normalized;
}

export function aggregateStatistic(
  samples: Array<number | null | undefined>,
  mode: StatisticMode,
  fallback?: number,
): number | undefined {
  const values = samples.filter(
    (value): value is number => typeof value === "number" && Number.isFinite(value),
  );
  if (values.length === 0) return fallback;
  if (mode === "max") return Math.max(...values);
  if (mode === "min") return Math.min(...values);
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function notifyNodeTestPreferencesChanged(): void {
  window.dispatchEvent(new Event(NODE_TEST_PREFERENCES_CHANGED));
}
