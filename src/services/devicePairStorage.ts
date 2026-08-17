import type { DevicePair } from "@/components/dialogs/PairSelectorDialog";

export const DEFAULT_DEVICE_PAIR: DevicePair = {
  senderId: "local",
  senderName: "本机",
  receiverId: "local",
  receiverName: "本机",
};

const DEVICE_PAIR_KEY = "node_test_pair";

type PairStorage = Pick<Storage, "getItem" | "setItem"> | Map<string, string>;

function getItem(storage: PairStorage, key: string): string | null {
  return storage instanceof Map ? (storage.get(key) ?? null) : storage.getItem(key);
}

function setItem(storage: PairStorage, key: string, value: string): void {
  if (storage instanceof Map) {
    storage.set(key, value);
  } else {
    storage.setItem(key, value);
  }
}

function isDevicePair(value: unknown): value is DevicePair {
  if (!value || typeof value !== "object") return false;
  const pair = value as Record<string, unknown>;
  return ["senderId", "senderName", "receiverId", "receiverName"].every(
    (key) => typeof pair[key] === "string" && pair[key],
  );
}

export function loadDevicePair(
  storage: PairStorage,
  username?: string,
): DevicePair {
  try {
    const key = username ? `${DEVICE_PAIR_KEY}__${username}` : DEVICE_PAIR_KEY;
    const value = getItem(storage, key);
    if (!value) return DEFAULT_DEVICE_PAIR;
    const parsed: unknown = JSON.parse(value);
    return isDevicePair(parsed) ? parsed : DEFAULT_DEVICE_PAIR;
  } catch {
    return DEFAULT_DEVICE_PAIR;
  }
}

export function saveDevicePair(
  storage: PairStorage,
  username: string | undefined,
  pair: DevicePair,
): void {
  if (!isDevicePair(pair)) return;
  const key = username ? `${DEVICE_PAIR_KEY}__${username}` : DEVICE_PAIR_KEY;
  setItem(storage, key, JSON.stringify(pair));
}
