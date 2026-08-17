export const HEARTBEAT_INTERVAL_MS = 10_000;
export const HEARTBEAT_TIMEOUT_MS = 60_000;

export function isCurrentSocket<T>(current: T | null, candidate: T): boolean {
  return current === candidate;
}
