export class TestRunController {
  readonly runId: string;
  readonly signal: AbortSignal;
  private readonly abortController = new AbortController();
  private stopBatch = false;
  private forceStopping = false;

  constructor(runId: string) {
    this.runId = runId;
    this.signal = this.abortController.signal;
  }

  requestStop(): void {
    this.stopBatch = true;
  }

  cancelStop(): void {
    if (!this.forceStopping) this.stopBatch = false;
  }

  forceStop(): void {
    this.stopBatch = true;
    this.forceStopping = true;
    this.abortController.abort(new DOMException("测速已强制停止", "AbortError"));
  }

  shouldStopBatch(): boolean {
    return this.stopBatch;
  }

  isForceStopping(): boolean {
    return this.forceStopping;
  }
}
