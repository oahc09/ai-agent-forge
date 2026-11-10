import { afterEach, expect, it } from 'vitest';
import { chmodSync, existsSync, linkSync, mkdirSync, readdirSync, renameSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CandidateWorkspace } from '../../packages/execution/src/candidate-workspace.ts';
import { LocalWorktreePool } from '../../packages/execution/src/worktrees.ts';
import { worktreeFixture } from '../unit/worktree-fixtures.ts';
const fixtures: ReturnType<typeof worktreeFixture>[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.cleanup(); });
function setup() {
  const fixture = worktreeFixture(); fixtures.push(fixture);
  const pool = new LocalWorktreePool(fixture.source, fixture.root);
  const lease = pool.create({ taskId: 'task-1', workerId: 'worker-1', commit: fixture.commit });
  return { fixture, pool, lease, workspace: pool.detach(lease.id) };
}
it.each(['.git', 'src/.GIT', 'src/bad name', 'src/trailing.'])('refuses unsafe candidate path %s without deleting it', path => {
  const { workspace } = setup(); writeFileSync(join(workspace.directory, path), 'retained');
  expect(() => workspace.inspect()).toThrow('inspection refused');
  expect(existsSync(join(workspace.directory, path))).toBe(true);
});
it.each(['file', 'directory', 'hardlink'])('rejects %s links without following them', kind => {
  const { fixture, workspace } = setup();
  const target = join(workspace.directory, 'linked');
  if (kind === 'hardlink') linkSync(join(fixture.source, 'src/file.txt'), target);
  else symlinkSync(kind === 'file' ? join(fixture.source, 'src/file.txt') : fixture.source, target);
  expect(() => workspace.inspect()).toThrow();
});
it('refuses replaced root identity', () => {
  const { workspace } = setup(); renameSync(workspace.directory, `${workspace.directory}-retained`); mkdirSync(workspace.directory);
  expect(() => workspace.inspect()).toThrow();
});
it.each(['oversized', 'setuid', 'case-collision', 'deep'])('rejects %s candidate data', kind => {
  const { workspace } = setup();
  if (kind === 'oversized') truncateSync(join(workspace.directory, 'src/file.txt'), 1048577);
  if (kind === 'setuid') chmodSync(join(workspace.directory, 'src/file.txt'), 0o4644);
  if (kind === 'case-collision') writeFileSync(join(workspace.directory, 'SRC'), 'collision');
  if (kind === 'deep') mkdirSync(join(workspace.directory, ...Array.from({ length: 65 }, () => 'a')), { recursive: true });
  expect(() => workspace.inspect()).toThrow();
});
it('never follows a baseline source link or accepts candidate Git metadata changes', () => {
  const { fixture, pool, lease } = setup();
  unlinkSync(join(lease.directory, 'src/file.txt'));
  symlinkSync(join(fixture.source, 'src/file.txt'), join(lease.directory, 'src/file.txt'));
  expect(() => pool.detach(lease.id)).toThrow();
});
it.each(['../outside', '/absolute', '.git/config', 'a/../b', 'a//b'])('validates constructor paths before allocation: %s', path => {
  const { fixture } = setup();
  expect(() => new CandidateWorkspace(fixture.root, { leaseId: 'lease-1', taskId: 'task-1', workerId: 'worker-1', commit: fixture.commit }, [{ path, bytes: Buffer.from('x'), mode: 0o644 }])).toThrow();
});
it('rejects baseline file-directory conflicts and case collisions', () => {
  const { fixture } = setup(), identity = { leaseId: 'lease-1', taskId: 'task-1', workerId: 'worker-1', commit: fixture.commit };
  for (const paths of [['a', 'a/b/c'], ['src/a', 'SRC/b'], ['same', 'same']]) expect(() => new CandidateWorkspace(fixture.root, identity, paths.map(path => ({ path, bytes: Buffer.from('x'), mode: 0o644 })))).toThrow();
});

it('refuses excessive baseline depth before allocating a directory', () => {
  const { fixture } = setup(), before = readdirSync(fixture.root).sort();
  expect(() => new CandidateWorkspace(fixture.root, { leaseId: 'lease-1', taskId: 'task-1', workerId: 'worker-1', commit: fixture.commit }, [
    { path: [...Array.from({ length: 65 }, () => 'a'), 'file'].join('/'), bytes: Buffer.from('x'), mode: 0o644 },
  ])).toThrow();
  expect(readdirSync(fixture.root).sort()).toEqual(before);
});

it('counts unique baseline directories and empty files before allocation', () => {
  const { fixture } = setup(), before = readdirSync(fixture.root).sort();
  const files = Array.from({ length: 4001 }, (_, i) => ({ path: `d${i}/a/b/c/file`, bytes: Buffer.alloc(0), mode: 0o644 }));
  expect(() => new CandidateWorkspace(fixture.root, { leaseId: 'lease-1', taskId: 'task-1', workerId: 'worker-1', commit: fixture.commit }, files)).toThrow();
  expect(readdirSync(fixture.root).sort()).toEqual(before);
});
