import fs from 'node:fs';
import path from 'node:path';
import ignore from 'ignore';

export interface IgnoreScope { directory: string; rules: ReturnType<typeof ignore> }

export function gitIgnored(relative: string, directory: boolean, scopes: IgnoreScope[]): boolean {
  let ignored = false;
  for (const scope of scopes) {
    const local = scope.directory ? relative.slice(scope.directory.length + 1) : relative;
    const result = scope.rules.test(local + (directory ? '/' : ''));
    if (result.ignored) ignored = true;
    else if (result.unignored) ignored = false;
  }
  return ignored;
}

/** A rule snapshot for one preview, explicit read or prompt assembly. */
export class ProjectIgnore {
  private readonly byDirectory = new Map<string, IgnoreScope[] | null>();
  private readonly configured;
  private bytes = 0;

  constructor(private readonly root: string, patterns: string[] = []) {
    this.configured = ignore().add(patterns);
  }

  private scopes(directory: string): IgnoreScope[] | null {
    const cached = this.byDirectory.get(directory);
    if (cached !== undefined) return cached;
    const parent = path.posix.dirname(directory);
    let rules = directory ? this.scopes(parent === '.' ? '' : parent) : [];
    if (rules) {
      const file = path.join(this.root, directory, '.gitignore');
      try {
        const stat = fs.lstatSync(file, { throwIfNoEntry: false });
        if (stat?.isFile()) {
          this.bytes += stat.size;
          rules = stat.size > 256_000 || this.bytes > 1_000_000 ? null
            : [...rules, { directory, rules: ignore().add(fs.readFileSync(file, 'utf8')) }];
        }
      } catch { rules = null; }
    }
    this.byDirectory.set(directory, rules);
    return rules;
  }

  excludes(relative: string, isDirectory: boolean): boolean {
    if (!relative || relative === '.') return false;
    const names = relative.split('/');
    let directory = '';
    for (const [index, name] of names.entries()) {
      const child = directory ? directory + '/' + name : name;
      const dir = index < names.length - 1 || isDirectory;
      const scopes = this.scopes(directory);
      if (!scopes || this.configured.ignores(child + (dir ? '/' : '')) || gitIgnored(child, dir, scopes)) return true;
      directory = child;
    }
    return false;
  }
}
