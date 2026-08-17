export interface BatchTestCompletion {
  allSucceeded: boolean;
  shouldShowLogs: boolean;
}

export function resolveBatchTestCompletion(
  totalCount: number,
  successCount: number,
  stopped: boolean,
  forceStopped: boolean,
): BatchTestCompletion {
  const allSucceeded = totalCount > 0 && successCount === totalCount && !stopped && !forceStopped;
  return {
    allSucceeded,
    shouldShowLogs: !allSucceeded,
  };
}

export function shouldClearBatchTestArtifacts(
  isRunning: boolean,
  preserveLogs: boolean,
): boolean {
  return !isRunning && !preserveLogs;
}
