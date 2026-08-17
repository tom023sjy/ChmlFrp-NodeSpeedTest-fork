export function calculateBatchOverallPercent(
  completedNodes: number,
  totalNodes: number,
  currentNodeProgress: number,
): number {
  if (totalNodes <= 0) return 0;
  const progress = Math.min(100, Math.max(0, currentNodeProgress));
  return Math.min(100, Math.max(0, ((completedNodes + progress / 100) / totalNodes) * 100));
}
