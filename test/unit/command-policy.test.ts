import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyCommand, type CommandCategory } from '@core/security/CommandPolicy';
import { evaluateCommandApproval, evaluateToolApproval, type ApprovalMode } from '@core/security/ApprovalPolicy';

// Synthetic path metadata only: none of the commands in this suite are executed.
const root = path.resolve('/__newai_policy_fixture__/project');
const cases: Array<[string, CommandCategory, boolean?]> = [
  ['ls -la', 'read'],
  ['pwd', 'read'],
  ['cat README.md', 'read'],
  ['head -n 20 src/main.ts', 'read'],
  ['tail -n 10 logs/example.log', 'read'],
  ['wc -l README.md', 'read'],
  ['rg --files', 'read'],
  ['grep -n title README.md', 'read'],
  ['find src -name "*.ts"', 'read'],
  ['git status --short', 'read'],
  ['git diff --stat', 'read'],
  ['git log -3 --oneline', 'read'],
  ['git show --stat HEAD', 'read'],
  ['git branch --show-current', 'read'],
  ['git -C fixtures status', 'read'],
  ['command -v node', 'read'],
  ['node --version', 'read'],
  ['python3 --version', 'read'],
  ['printf ready', 'read'],
  ["printf '%s' 'literal $label'", 'read'],
  ['cat README.md | wc -l', 'read'],
  ['git diff; git status', 'read'],
  ['npm test', 'build'],
  ['npm run typecheck', 'build'],
  ['npm ci', 'build'],
  ['pnpm run build', 'build'],
  ['yarn test', 'build'],
  ['bun test', 'build'],
  ['npx tsc --noEmit', 'build'],
  ['cargo check', 'build'],
  ['cargo test -p example', 'build'],
  ['go test ./...', 'build'],
  ['go vet ./...', 'build'],
  ['pytest -q', 'build'],
  ['python3 -m pytest -q', 'build'],
  ['node --check scripts/check.mjs', 'build'],
  ['mvn -q test', 'build'],
  ['make check', 'build'],
  ['env NODE_ENV=test npm test', 'build'],
  ['CI=true npm run build', 'build'],
  ['npm test && npm run build', 'build'],
  ['git status\nnpm test', 'build'],
  ['touch fixtures/example.tmp', 'write'],
  ['mkdir -p fixtures/output', 'write'],
  ['cp fixtures/input.txt fixtures/output.txt', 'write'],
  ['mv fixtures/input.txt fixtures/renamed.txt', 'write'],
  ['rm fixtures/example.tmp', 'write'],
  ['chmod u+x fixtures/check.sh', 'write'],
  ['git add fixtures/example.txt', 'write'],
  ['git commit -m "Example fixture"', 'write'],
  ['printf ready > fixtures/status.txt', 'write'],
  ['printf ready >> fixtures/status.txt', 'write'],
  ['cd fixtures && touch example.tmp', 'write'],
  ['touch /__newai_policy_neighbor__/example.tmp', 'write', true],
  ['printf ready > /__newai_policy_neighbor__/status.txt', 'write', true],
  ['curl --head https://example.com', 'network'],
  ['wget --spider https://example.com', 'network'],
  ['ssh -V', 'network'],
  ['git fetch --dry-run', 'network'],
  ['git push --dry-run', 'network'],
  ['npm view example version', 'network'],
  ['sudo --version', 'escalate'],
  ['su --help', 'escalate'],
  ['launchctl help', 'escalate'],
  ['diskutil list', 'escalate'],
  ['systemctl --version', 'escalate'],
  ['dd --help', 'escalate'],
  ['git status && sudo --version', 'escalate'],
  ['node -e "console.log(1)"', 'opaque'],
  ['python3 -c "print(1)"', 'opaque'],
  ['ruby -e "puts 1"', 'opaque'],
  ['bash -c "printf ready"', 'opaque'],
  ['printf "%s" "$BUILD_LABEL"', 'opaque'],
  ['custom-check --help', 'opaque'],
  ['./fixtures/check.sh', 'opaque'],
  ['npm unknown-operation', 'opaque'],
  ['npx unknown-example-tool', 'opaque'],
];

describe('command classification using ordinary synthetic metadata', () => {
  it.each(cases)('classifies %s as %s', (command, category, outsideProject = false) => {
    expect(classifyCommand(command, root)).toMatchObject({ category, outsideProject });
    expect(classifyCommand(command, root).reasons.length).toBeGreaterThan(0);
  });

  it('tracks an explicitly supplied working directory within the project', () => {
    const cwd = path.join(root, 'fixtures', 'nested');
    expect(classifyCommand('touch ../example.tmp', root, cwd)).toMatchObject({ category: 'write', outsideProject: false });
    expect(classifyCommand('touch example.tmp')).toMatchObject({ category: 'write', outsideProject: true });
  });

  it('keeps quoted punctuation and comments as ordinary text', () => {
    expect(classifyCommand('printf "a;b|c"', root).category).toBe('read');
    expect(classifyCommand('git status # ordinary status\nnpm test', root).category).toBe('build');
    expect(classifyCommand('printf "incomplete', root).category).toBe('opaque');
    expect(classifyCommand('', root).category).toBe('opaque');
  });
});

describe('command approval matrix', () => {
  it.each(cases)('applies all three modes to %s', (command, category, outsideProject = false) => {
    for (const mode of ['ask', 'auto', 'full'] as ApprovalMode[]) {
      const expected = mode === 'ask' || category === 'escalate' || (mode === 'auto' && (['network', 'opaque'].includes(category) || (category === 'write' && outsideProject))) ? 'confirm' : 'allow';
      expect(evaluateCommandApproval(mode, command, root)).toMatchObject({ decision: expected, category, outsideProject });
      expect(evaluateToolApproval(mode, { toolName: 'run_command', input: { command }, projectRoot: root })).toEqual(evaluateCommandApproval(mode, command, root));
    }
  });
});
