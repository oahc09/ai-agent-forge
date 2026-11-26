import { afterEach, expect, it } from 'vitest';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LocalWorktreePool } from '../../packages/execution/src/worktrees.ts';
import { localGit, worktreeFixture } from '../unit/worktree-fixtures.ts';
const fixtures: ReturnType<typeof worktreeFixture>[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.cleanup(); });
function setup() {
  const fixture = worktreeFixture(); fixtures.push(fixture);
  const pool = new LocalWorktreePool(fixture.source, fixture.root);
  const lease = pool.create({ taskId: 'task-1', workerId: 'worker-1', commit: fixture.commit });
  return { fixture, pool, lease };
}
it('detaches exact baseline into independent regular files without Git metadata', () => {
  const { fixture, pool, lease } = setup(), workspace = pool.detach(lease.id);
  expect(existsSync(join(workspace.directory, '.git'))).toBe(false);
  const path = join(workspace.directory, 'src/file.txt');
  expect(readFileSync(path, 'utf8')).toBe('original\n');
  expect(lstatSync(path).ino).not.toBe(lstatSync(join(lease.directory, 'src/file.txt')).ino);
  expect(lstatSync(path).nlink).toBe(1);
  expect(workspace.inspect()).toMatchObject({ identity: { commit: fixture.commit, leaseId: lease.id }, changes: [], isolationVerified: false, applied: false });
  pool.release(lease.id);
  expect(readFileSync(path, 'utf8')).toBe('original\n');
  expect(workspace.inspect().changes).toEqual([]);
});
it('reports added, deleted, content and executable-mode changes without applying them', () => {
  const { fixture, pool, lease } = setup(), workspace = pool.detach(lease.id);
  const original = workspace.inspect();
  writeFileSync(join(workspace.directory, 'src/file.txt'), 'candidate\n');
  unlinkSync(join(workspace.directory, '.gitignore'));
  writeFileSync(join(workspace.directory, 'new.txt'), 'new\n');
  chmodSync(join(workspace.directory, 'src/file.txt'), 0o755);
  mkdirSync(join(workspace.directory, 'empty'));
  const inventory = workspace.inspect();
  expect(inventory.changes.map(c => [c.path, c.kind])).toEqual([['.gitignore', 'deleted'], ['new.txt', 'added'], ['src/file.txt', 'modified']]);
  expect(inventory.directories).toContain('empty');
  expect(inventory.baselineDigest).toBe(original.baselineDigest);
  expect(inventory.candidateDigest).not.toBe(original.candidateDigest);
  expect(readFileSync(join(fixture.source, 'src/file.txt'), 'utf8')).toBe('original\n');
  expect(localGit(fixture.source, ['status', '--porcelain'])).toBe('');
  expect(JSON.stringify(inventory)).not.toContain('candidate\\n');
  inventory.identity.commit = 'f'.repeat(40); inventory.changes[2]!.before!.sha256 = 'tampered';
  expect(workspace.inspect().identity.commit).toBe(fixture.commit);
  expect(workspace.inspect().changes[2]!.before!.sha256).not.toBe('tampered');
});
it('does not export changed, unknown or released leases', () => {
  const { pool, lease } = setup();
  expect(() => pool.detach('unknown')).toThrow();
  writeFileSync(join(lease.directory, 'src/file.txt'), 'changed');
  expect(() => pool.detach(lease.id)).toThrow();
  writeFileSync(join(lease.directory, 'src/file.txt'), 'original\n');
  pool.release(lease.id);
  expect(() => pool.detach(lease.id)).toThrow();
});
it('keeps two candidates independent and caps retained exports', () => {
  const { pool, lease } = setup(), first = pool.detach(lease.id), second = pool.detach(lease.id);
  writeFileSync(join(first.directory, 'src/file.txt'), 'first only');
  expect(second.inspect().changes).toEqual([]);
  for (let i = 2; i < 32; i++) pool.detach(lease.id);
  expect(() => pool.detach(lease.id)).toThrow('history limit');
});
it('hashes mode-only changes and empty directories deterministically', () => {
  const { pool, lease } = setup(), workspace = pool.detach(lease.id);
  const before = workspace.inspect();
  chmodSync(join(workspace.directory, 'src/file.txt'), 0o755);
  expect(workspace.inspect().changes[0]).toMatchObject({ kind: 'modified', before: { mode: 0o644 }, after: { mode: 0o755 } });
  chmodSync(join(workspace.directory, 'src/file.txt'), 0o644);
  mkdirSync(join(workspace.directory, 'empty'));
  expect(workspace.inspect().changes).toEqual([]);
  expect(workspace.inspect().candidateDigest).not.toBe(before.candidateDigest);
  expect(workspace.inspect()).toEqual(workspace.inspect());
});

it('preserves verified baseline modes even when the host umask changes', () => {
  const { pool, lease } = setup();
  const previous = process.umask(0o077);
  try {
    const workspace = pool.detach(lease.id);
    expect(lstatSync(join(workspace.directory, 'src/file.txt')).mode & 0o777).toBe(0o644);
    expect(workspace.inspect().changes).toEqual([]);
  } finally { process.umask(previous); }
});
it('supports leases created under a restrictive umask including executable files', () => {
  const fixture = worktreeFixture(); fixtures.push(fixture);
  writeFileSync(join(fixture.source, 'run.sh'), 'fixture only\n');
  chmodSync(join(fixture.source, 'run.sh'), 0o755);
  localGit(fixture.source, ['add', 'run.sh']); localGit(fixture.source, ['commit', '-qm', 'executable fixture']);
  const previous = process.umask(0o077);
  try {
    const pool = new LocalWorktreePool(fixture.source, fixture.root);
    const lease = pool.create({ taskId: 'task-1', workerId: 'worker-1', commit: localGit(fixture.source, ['rev-parse', 'HEAD']) });
    const workspace = pool.detach(lease.id);
    expect(lstatSync(join(workspace.directory, 'src/file.txt')).mode & 0o777).toBe(0o600);
    expect(lstatSync(join(workspace.directory, 'run.sh')).mode & 0o777).toBe(0o700);
    expect(workspace.inspect().changes).toEqual([]);
  } finally { process.umask(previous); }
});
