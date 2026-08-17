export interface SpeedSample {
  second: number;
  bytes: number;
  durationMs: number;
  mbps: number;
}

export function calculateMbps(bytes: number, durationMs: number): number {
  if (durationMs <= 0) return 0;
  return bytes * 8 / (durationMs / 1_000) / 1_000_000;
}

export function createSpeedSample(second: number, bytes: number, durationMs: number): SpeedSample {
  return {
    second,
    bytes,
    durationMs,
    mbps: calculateMbps(bytes, durationMs),
  };
}

export function normalizeDurationSeconds(value: number | undefined): number {
  if (value == null || !Number.isFinite(value)) return 15;
  return Math.max(5, Math.min(120, Math.trunc(value)));
}
