import { createHash } from 'node:crypto';
import fs from 'node:fs';

/**
 * Remembers the exact bytes the agent last read or wrote per file.
 *
 * Pi's write tool overwrites a file without reading it first, so any edit made
 * outside the agent (a user in an editor, a formatter, a second session) between
 * the agent's read and its write would be lost silently. The write path asks
 * this guard whether the file still matches what the agent saw; a mismatch
 * becomes a visible, actionable tool error instead of data loss.
 *
 * Files never read or written by the agent are allowed: creating new files and
 * deliberate complete rewrites must keep working.
 */
export interface FileFingerprint {
  sha256: string;
  size: number;
}

/** Older entries are evicted; the map holds only digests, never file contents. */
const MAX_TRACKED_FILES = 2_000;

function digest(content: string | Buffer): FileFingerprint {
  const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  return { sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.byteLength };
}

export class FileWriteGuard {
  private readonly fingerprints = new Map<string, FileFingerprint>();

  /** Record the state of a file as the agent now sees it. */
  record(filePath: string, content: string | Buffer): void {
    // Delete first so the newest entry moves to the end of the insertion order.
    this.fingerprints.delete(filePath);
    this.fingerprints.set(filePath, digest(content));
    while (this.fingerprints.size > MAX_TRACKED_FILES) {
      const oldest = this.fingerprints.keys().next().value;
      if (!oldest) break;
      this.fingerprints.delete(oldest);
    }
  }

  forget(filePath: string): void { this.fingerprints.delete(filePath); }

  /** Whether the agent has seen this file in the current process. */
  tracks(filePath: string): boolean { return this.fingerprints.has(filePath); }

  /**
   * Throw when a file tracked by the agent changed on disk since it was read or
   * written. Untracked files, untouched files and files deleted after the read
   * are writable: the write either creates the file or restores it deliberately.
   */
  async assertUnchangedSinceRead(filePath: string, displayPath = filePath): Promise<void> {
    const known = this.fingerprints.get(filePath);
    if (!known) return;
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') { this.fingerprints.delete(filePath); return; }
      throw error;
    }
    if (stat.size === known.size && stat.isFile()) {
      let current: Buffer;
      try { current = await fs.promises.readFile(filePath); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        this.fingerprints.delete(filePath);
        return;
      }
      if (digest(current).sha256 === known.sha256) return;
    }
    throw new Error(
      `文件 ${displayPath} 在 Agent 上次读取后已被外部修改（可能来自编辑器、格式化工具或其他会话）。`
      + '为避免覆盖这些改动，本次写入已阻止。请先重新 read 该文件确认最新内容，再按最新内容写入或改用 edit 做局部修改。',
    );
  }
}

/**
 * Process-wide instance: tools are rebuilt for every agent turn, and a guard
 * scoped to one turn would miss cross-turn edits. Every file mutation made
 * through the built-in tools refreshes the record, so only genuinely external
 * changes are blocked.
 */
export const defaultFileWriteGuard = new FileWriteGuard();
