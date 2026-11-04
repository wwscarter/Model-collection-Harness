/** Stop awaiting cooperative async work as soon as its caller is cancelled. */
export function awaitWithSignal<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error('任务已取消'));
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    pending.then((value) => { cleanup(); resolve(value); }, (error) => { cleanup(); reject(error); });
    if (signal.aborted) { cleanup(); abort(); }
  });
}
