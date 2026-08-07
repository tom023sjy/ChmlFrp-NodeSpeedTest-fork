import { invoke } from "@tauri-apps/api/core";

/** 设备唯一标识在加密数据库中的存储 key */
const DEVICE_ID_KEY = "device_id";

/** 内存缓存，避免重复读取数据库 */
let cachedDeviceId: string | null = null;

/**
 * 获取本机设备唯一标识。
 * 首次调用时生成 UUID v4 并持久化到加密数据库，后续直接返回缓存。
 * 用于设备互联 WebSocket 注册，同一设备跨重启保持一致。
 */
export async function getDeviceId(): Promise<string> {
  if (cachedDeviceId) return cachedDeviceId;

  try {
    const existing = await invoke<string>("secure_load", { key: DEVICE_ID_KEY });
    if (existing) {
      cachedDeviceId = existing;
      return existing;
    }
  } catch (err) {
    console.warn("[deviceId] 读取加密数据库失败:", err);
  }

  // 生成新 UUID v4
  const id = crypto.randomUUID();
  try {
    await invoke("secure_store", { key: DEVICE_ID_KEY, value: id });
  } catch (err) {
    console.warn("[deviceId] 持久化失败，仅使用内存缓存:", err);
  }
  cachedDeviceId = id;
  return id;
}
