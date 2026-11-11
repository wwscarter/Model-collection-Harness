/**
 * Wall-clock budget for one agent run that can be paused while a long external
 * operation (image generation) is in flight. Model calls and tool loops still
 * consume the budget; waiting for an image endpoint does not, because a single
 * high-quality generation or a batch of several can legitimately exceed the
 * agent's five-minute loop window.
 *
 * The run budget deadline in RunContext remains the outer bound on total time
 * and is user-configurable.
 */
export interface RunDeadline {
  readonly signal: AbortSignal;
  /** Stop counting time (nestable). */
  hold(): void;
  /** Resume counting when the last hold is released. */
  release(): void;
  dispose(): void;
}

/** Ref-counted pause: one resume for every hold, nested callers included. */
export function createPauseGroup(pause: () => () => void): () => () => void {
  let holds = 0;
  let resume: (() => void) | undefined;
  return () => {
    if (holds === 0) resume = pause();
    holds += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      holds -= 1;
      if (holds === 0) { resume?.(); resume = undefined; }
    };
  };
}

export function createRunDeadline(timeoutMs: number): RunDeadline {
  const controller = new AbortController();
  let remaining = Math.max(1, timeoutMs);
  let startedAt = Date.now();
  let holds = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const arm = () => {
    timer = setTimeout(() => {
      // Match AbortSignal.timeout: verification/status code distinguishes a
      // deadline from user cancellation by the TimeoutError name.
      const reason = new Error('Agent run deadline exceeded');
      reason.name = 'TimeoutError';
      controller.abort(reason);
    }, remaining);
    timer.unref?.();
  };
  const disarm = () => { if (timer) clearTimeout(timer); timer = undefined; };
  arm();

  return {
    signal: controller.signal,
    hold() {
      if (holds === 0) {
        disarm();
        remaining = Math.max(0, remaining - (Date.now() - startedAt));
      }
      holds += 1;
    },
    release() {
      if (holds === 0) return;
      holds -= 1;
      if (holds > 0 || controller.signal.aborted) return;
      startedAt = Date.now();
      arm();
    },
    dispose: disarm,
  };
}
