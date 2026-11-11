/** A single file write observed by the agent. Kept free of storage details so tools can report it. */
export interface FileChangeTarget {
  /** Absolute path that was written. */
  path: string;
  /** Project-relative path used for display and restore safety checks. */
  relativePath: string;
}

/**
 * Receives the state of a file immediately before and after the agent mutates
 * it. Implementations must not throw: losing rollback history is regrettable,
 * but failing a user's write because bookkeeping failed is worse.
 */
export interface FileChangeRecorder {
  beforeWrite(file: FileChangeTarget): Promise<void>;
  afterWrite(file: FileChangeTarget & { content: string | Buffer }): Promise<void>;
}

/** Run every recorder, so rollback history and audit stay independent. */
export function combineFileChangeRecorders(recorders: FileChangeRecorder[]): FileChangeRecorder {
  return {
    beforeWrite: async (file) => { for (const recorder of recorders) await recorder.beforeWrite(file); },
    afterWrite: async (file) => { for (const recorder of recorders) await recorder.afterWrite(file); },
  };
}
