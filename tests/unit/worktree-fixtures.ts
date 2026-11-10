import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
export function localGit(directory: string, args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgSign=false', ...args], {
    cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: '/usr/local/bin:/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' },
  }).trim();
}
export function worktreeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'forge-worktree-test-'));
  const source = join(root, 'source'); mkdirSync(source);
  localGit(source, ['init', '-q']);
  mkdirSync(join(source, 'src')); writeFileSync(join(source, 'src', 'file.txt'), 'original\n');
  writeFileSync(join(source, '.gitignore'), 'ignored.txt\n');
  localGit(source, ['add', '.']); localGit(source, ['commit', '-qm', 'fixture']);
  const commit = localGit(source, ['rev-parse', 'HEAD']);
  return { root, source, commit, cleanup: () => rmSync(root, { recursive: true }) };
}
