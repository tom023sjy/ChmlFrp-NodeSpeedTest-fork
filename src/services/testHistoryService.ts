import type { SpeedSample } from "./speedSamples";
import type { LogEntry } from "./speedTestService";

export interface TestHistoryRecord {
  nodeName: string;
  nodeId: number;
  timestamp: number;
  latency?: number;
  downloadSpeed?: number;
  success: boolean;
  error?: string;
  senderId: string;
  senderName: string;
  receiverId: string;
  receiverName: string;
  pairKey: string;
  latencySamples?: Array<number | null>;
  speedSamples?: SpeedSample[];
  jitterMs?: number;
  packetLossPercent?: number;
  testDurationSeconds?: number;
  logs?: LogEntry[];
}

export interface TestHistoryPair {
  senderId: string;
  senderName: string;
  receiverId: string;
  receiverName: string;
}

const STORAGE_KEY_PREFIX = "node_test_history";
const MAX_HISTORY_PER_NODE = 50;

function storageKey(username: string | undefined | null): string {
  if (!username) {
    return STORAGE_KEY_PREFIX;
  }
  return `${STORAGE_KEY_PREFIX}__${username}`;
}

function defaultPair(): TestHistoryPair {
  return {
    senderId: "local",
    senderName: "本机",
    receiverId: "local",
    receiverName: "本机",
  };
}

function pairKey(pair: Pick<TestHistoryPair, "senderId" | "receiverId">): string {
  return `${pair.senderId}__${pair.receiverId}`;
}

function normalizeRecord(record: Omit<TestHistoryRecord, "senderId" | "senderName" | "receiverId" | "receiverName" | "pairKey"> & Partial<TestHistoryPair & Pick<TestHistoryRecord, "pairKey">>): TestHistoryRecord {
  const pair = record.senderId && record.receiverId
    ? {
        senderId: record.senderId,
        senderName: record.senderName ?? record.senderId,
        receiverId: record.receiverId,
        receiverName: record.receiverName ?? record.receiverId,
      }
    : defaultPair();
  return { ...record, ...pair, pairKey: record.pairKey ?? pairKey(pair) };
}

function migrateLegacy(username: string | undefined | null): void {
  if (!username) return;
  const newKey = storageKey(username);
  if (localStorage.getItem(newKey)) return;
  const legacy = localStorage.getItem(STORAGE_KEY_PREFIX);
  if (!legacy) return;
  try {
    const records = JSON.parse(legacy) as Array<Record<string, unknown>>;
    localStorage.setItem(newKey, JSON.stringify(records.map((record) => normalizeRecord(record as never))));
    localStorage.removeItem(STORAGE_KEY_PREFIX);
  } catch {
    return;
  }
}

export function getTestHistory(username?: string): TestHistoryRecord[] {
  migrateLegacy(username);
  try {
    const stored = localStorage.getItem(storageKey(username));
    return stored ? (JSON.parse(stored) as Array<Record<string, unknown>>).map((record) => normalizeRecord(record as never)) : [];
  } catch {
    return [];
  }
}

export function getNodeTestHistory(nodeName: string, username?: string, pair?: TestHistoryPair): TestHistoryRecord[] {
  const history = getTestHistory(username);
  const selectedPairKey = pair ? pairKey(pair) : undefined;
  return history
    .filter((r) => r.nodeName === nodeName && (!selectedPairKey || r.pairKey === selectedPairKey))
    .sort((a, b) => b.timestamp - a.timestamp);
}

export function addTestHistory(record: TestHistoryRecord, username?: string): void {
  const history = getTestHistory(username);
  history.unshift(normalizeRecord(record as never));

  const grouped: Record<string, TestHistoryRecord[]> = {};
  history.forEach((r) => {
    const groupKey = `${r.nodeName}::${r.pairKey}`;
    if (!grouped[groupKey]) {
      grouped[groupKey] = [];
    }
    if (grouped[groupKey].length < MAX_HISTORY_PER_NODE) {
      grouped[groupKey].push(r);
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
