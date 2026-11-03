import fs from 'node:fs';
import path from 'node:path';

export interface GitInfo { branch?: string; detached?: boolean; head?: string; }

export interface ProjectInspection {
  /** Resolved (realpath) root. */
  root: string;
  suggestedName: string;
  git?: GitInfo;
  languages: string[];
  /** Root-level build/manifest files that were found, in a stable order. */
  markers: string[];
}

const MARKERS: ReadonlyArray<{ file: string; language: string }> = [
  { file: 'package.json', language: 'JavaScript' },
  { file: 'tsconfig.json', language: 'TypeScript' },
  { file: 'pyproject.toml', language: 'Python' },
  { file: 'requirements.txt', language: 'Python' },
  { file: 'setup.py', language: 'Python' },
  { file: 'Cargo.toml', language: 'Rust' },
  { file: 'go.mod', language: 'Go' },
  { file: 'pom.xml', language: 'Java' },
  { file: 'build.gradle', language: 'Java' },
  { file: 'build.gradle.kts', language: 'Kotlin' },
  { file: 'Gemfile', language: 'Ruby' },
  { file: 'composer.json', language: 'PHP' },
  { file: 'Package.swift', language: 'Swift' },
  { file: 'CMakeLists.txt', language: 'C/C++' },
];
const MAX_POINTER_BYTES = 4096;

function readSmallFile(file: string): string | undefined {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_POINTER_BYTES) return undefined;
    return fs.readFileSync(file, 'utf8');
  } catch { return undefined; }
}

/** Reads the checked-out branch without spawning git. Handles normal repos and worktree/submodule `.git` pointer files. */
export function readGitInfo(root: string): GitInfo | undefined {
  const dotGit = path.join(root, '.git');
  let gitDir: string;
  try {
    const stat = fs.statSync(dotGit);
    if (stat.isDirectory()) gitDir = dotGit;
    else if (stat.isFile()) {
      const pointer = readSmallFile(dotGit)?.match(/^gitdir:\s*(.+)$/m)?.[1]?.trim();
      if (!pointer) return undefined;
      gitDir = path.resolve(root, pointer);
    } else return undefined;
  } catch { return undefined; }
  const head = readSmallFile(path.join(gitDir, 'HEAD'))?.trim();
  if (!head) return undefined;
  const branch = head.match(/^ref:\s*refs\/heads\/(.+)$/)?.[1];
  if (branch) return { branch };
  if (/^[0-9a-f]{7,64}$/i.test(head)) return { detached: true, head: head.slice(0, 7) };
  return undefined;
}

/** Cheap, read-only facts about a folder for the "new project" dialog. Never reads file contents beyond `.git/HEAD`. */
export function inspectProject(root: string): ProjectInspection {
  const resolved = fs.realpathSync(root);
  if (!fs.statSync(resolved).isDirectory()) throw new Error('Project root must be a directory');
  const found = MARKERS.filter(({ file }) => {
    try { return fs.statSync(path.join(resolved, file)).isFile(); } catch { return false; }
  });
  const languages = [...new Set(found.map(({ language }) => language))];
  return {
    root: resolved,
    suggestedName: path.basename(resolved) || resolved,
    git: readGitInfo(resolved),
    // tsconfig.json implies package.json; show "TypeScript" rather than both.
    languages: languages.includes('TypeScript') ? languages.filter((language) => language !== 'JavaScript') : languages,
    markers: found.map(({ file }) => file),
  };
}
