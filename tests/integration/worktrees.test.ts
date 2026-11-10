import { expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { LocalWorktreePool } from '../../packages/execution/src/worktrees.ts';
import { localGit, worktreeFixture } from '../unit/worktree-fixtures.ts';
it('creates distinct real detached locked worktrees pinned to the same immutable commit', () => {
  const fixture = worktreeFixture();
  try {
    const pool = new LocalWorktreePool(fixture.source, fixture.root);
    const one = pool.create({ taskId: 'task-1', workerId: 'worker-1', commit: fixture.commit });
    const two = pool.create({ taskId: 'task-2', workerId: 'worker-2', commit: fixture.commit });
    expect(one.directory).not.toBe(two.directory);
    for (const lease of [one, two]) {
      expect(lease).toMatchObject({ state: 'ready', isolation: 'worktree-only-not-os-sandbox' });
      expect(localGit(lease.directory, ['rev-parse', 'HEAD'])).toBe(fixture.commit);
      expect(readFileSync(join(lease.directory, 'src/file.txt'), 'utf8')).toBe('original\n');
      expect(statSync(join(lease.directory, 'src/file.txt')).ino).not.toBe(statSync(join(fixture.source, 'src/file.txt')).ino);
    }
    expect(localGit(fixture.source, ['worktree', 'list', '--porcelain'])).toContain('locked AgentForge');
    writeFileSync(join(one.directory, 'src/file.txt'), 'candidate\n');
    expect(readFileSync(join(two.directory, 'src/file.txt'), 'utf8')).toBe('original\n');
    expect(readFileSync(join(fixture.source, 'src/file.txt'), 'utf8')).toBe('original\n');
    expect(() => pool.release(one.id)).toThrow('preserved');
    expect(pool.release(two.id).state).toBe('released');
    expect(existsSync(two.directory)).toBe(false);
    expect(JSON.parse(readFileSync(join(pool.root, `${two.id}.json`), 'utf8')).lease.state).toBe('released');
    expect(localGit(fixture.source, ['rev-parse', 'HEAD'])).toBe(fixture.commit);
  } finally { fixture.cleanup(); }
});
it('refuses task/worker reuse, mutable refs, foreign leases and caller-mutated lease data', () => {
  const fixture = worktreeFixture();
  try {
    const pool = new LocalWorktreePool(fixture.source, fixture.root);
    const lease = pool.create({ taskId: 'task', workerId: 'worker', commit: fixture.commit });
    expect(() => pool.create({ taskId: 'task', workerId: 'other', commit: fixture.commit })).toThrow('reserved');
    expect(() => pool.create({ taskId: 'other', workerId: 'worker', commit: fixture.commit })).toThrow('reserved');
    expect(() => pool.create({ taskId: 'other', workerId: 'other', commit: 'HEAD' })).toThrow('exact commit');
    expect(() => pool.release('foreign')).toThrow();
    lease.directory = fixture.source;
    expect(pool.inspect(lease.id)?.directory).not.toBe(fixture.source);
    pool.release(lease.id);
    expect(readFileSync(join(fixture.source, 'src/file.txt'), 'utf8')).toBe('original\n');
  } finally { fixture.cleanup(); }
});
it('supports a host source that is itself a linked worktree without sharing writable files', () => {
  const fixture = worktreeFixture();
  try {
    const linked = join(fixture.root, 'linked');
    localGit(fixture.source, ['worktree', 'add', '--detach', linked, fixture.commit]);
    const pool = new LocalWorktreePool(linked, fixture.root);
    const lease = pool.create({ taskId: 'task', workerId: 'worker', commit: fixture.commit });
    expect(pool.release(lease.id).state).toBe('released');
  } finally { fixture.cleanup(); }
});
it('materializes the approved commit without altering existing source working changes', () => {
  const fixture = worktreeFixture();
  try {
    writeFileSync(join(fixture.source, 'src/file.txt'), 'uncommitted user work\n');
    const pool = new LocalWorktreePool(fixture.source, fixture.root);
    const lease = pool.create({ taskId: 'task', workerId: 'worker', commit: fixture.commit });
    expect(readFileSync(join(lease.directory, 'src/file.txt'), 'utf8')).toBe('original\n');
    pool.release(lease.id);
    expect(readFileSync(join(fixture.source, 'src/file.txt'), 'utf8')).toBe('uncommitted user work\n');
  } finally { fixture.cleanup(); }
});
