export interface TestHistoryRecord {
  nodeName: string;
  nodeId: number;
  timestamp: number;
  latency?: number;
  downloadSpeed?: number;
  success: boolean;
  error?: string;
}

const STORAGE_KEY_PREFIX = "node_test_history";
const MAX_HISTORY_PER_NODE = 50;

/// 按账号隔离的存储 key：node_test_history__${username}
/// 旧数据（无后缀）首次访问时自动迁移到当前账号名下
function storageKey(username: string | undefined | null): string {
  if (!username) {
    // 未登录时回退到旧 key，避免数据丢失
    return STORAGE_KEY_PREFIX;
  }
  return `${STORAGE_KEY_PREFIX}__${username}`;
}

/// 一次性迁移旧数据到当前账号 key
/// 仅当旧 key 存在且新 key 不存在时执行
function migrateLegacy(username: string | undefined | null): void {
  if (!username) return;
  const newKey = storageKey(username);
  if (localStorage.getItem(newKey)) return; // 新 key 已有数据，不覆盖
  const legacy = localStorage.getItem(STORAGE_KEY_PREFIX);
  if (!legacy) return; // 旧 key 无数据
  try {
    JSON.parse(legacy); // 校验格式
    localStorage.setItem(newKey, legacy);
    localStorage.removeItem(STORAGE_KEY_PREFIX); // 移除旧 key 避免重复迁移
  } catch {
    // 旧数据格式错误，跳过迁移
  }
}

export function getTestHistory(username?: string): TestHistoryRecord[] {
  migrateLegacy(username);
  try {
    const stored = localStorage.getItem(storageKey(username));
    return stored ? JSON.parse(stored) : [];
  } catch {
    return [];
  }
}

export function getNodeTestHistory(nodeName: string, username?: string): TestHistoryRecord[] {
  const history = getTestHistory(username);
  return history
    .filter((r) => r.nodeName === nodeName)
    .sort((a, b) => b.timestamp - a.timestamp);
}

export function addTestHistory(record: TestHistoryRecord, username?: string): void {
  const history = getTestHistory(username);
  history.unshift(record);

  const grouped: Record<string, TestHistoryRecord[]> = {};
  history.forEach((r) => {
    if (!grouped[r.nodeName]) {
      grouped[r.nodeName] = [];
    }
    if (grouped[r.nodeName].length < MAX_HISTORY_PER_NODE) {
      grouped[r.nodeName].push(r);
    }
  });

  const filtered: TestHistoryRecord[] = [];
  Object.values(grouped).forEach((records) => {
    filtered.push(...records);
  });

  localStorage.setItem(storageKey(username), JSON.stringify(filtered));
}

export function getTestStats(records: TestHistoryRecord[]): {
  latencyMin?: number;
  latencyMax?: number;
  latencyAvg?: number;
  speedMin?: number;
  speedMax?: number;
  speedAvg?: number;
  successRate: number;
  totalTests: number;
} {
  const latencyRecords = records.filter((r) => r.latency != null);
  const speedRecords = records.filter((r) => r.downloadSpeed != null);
  const successRecords = records.filter((r) => r.success);

  const stats = {
    latencyMin: latencyRecords.length > 0 ? Math.min(...latencyRecords.map((r) => r.latency!)) : undefined,
    latencyMax: latencyRecords.length > 0 ? Math.max(...latencyRecords.map((r) => r.latency!)) : undefined,
    latencyAvg: latencyRecords.length > 0 ? latencyRecords.reduce((sum, r) => sum + (r.latency || 0), 0) / latencyRecords.length : undefined,
    speedMin: speedRecords.length > 0 ? Math.min(...speedRecords.map((r) => r.downloadSpeed!)) : undefined,
    speedMax: speedRecords.length > 0 ? Math.max(...speedRecords.map((r) => r.downloadSpeed!)) : undefined,
    speedAvg: speedRecords.length > 0 ? speedRecords.reduce((sum, r) => sum + (r.downloadSpeed || 0), 0) / speedRecords.length : undefined,
    successRate: records.length > 0 ? (successRecords.length / records.length) * 100 : 0,
    totalTests: records.length,
  };

  return stats;
}
