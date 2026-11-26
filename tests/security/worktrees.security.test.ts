import { expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync, symlinkSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { LocalWorktreePool } from '../../packages/execution/src/worktrees.ts';
import { localGit, worktreeFixture } from '../unit/worktree-fixtures.ts';
it.each(['modified', 'deleted', 'untracked', 'ignored', 'empty-directory', 'symlink'] as const)('preserves %s candidate state instead of force-cleaning', change => {
  const fixture = worktreeFixture();
  try {
    const pool = new LocalWorktreePool(fixture.source, fixture.root);
    const lease = pool.create({ taskId: 'task', workerId: 'worker', commit: fixture.commit });
    if (change === 'modified') writeFileSync(join(lease.directory, 'src/file.txt'), 'changed\n');
    if (change === 'deleted') unlinkSync(join(lease.directory, 'src/file.txt'));
    if (change === 'untracked') writeFileSync(join(lease.directory, 'new.txt'), 'keep me');
    if (change === 'ignored') writeFileSync(join(lease.directory, 'ignored.txt'), 'keep ignored');
    if (change === 'empty-directory') mkdirSync(join(lease.directory, 'new-dir'));
    if (change === 'symlink') symlinkSync(fixture.source, join(lease.directory, 'outside'));
    expect(() => pool.release(lease.id)).toThrow('preserved');
    expect(existsSync(lease.directory)).toBe(true);
    expect(pool.inspect(lease.id)?.state).toBe('ready');
  } finally { fixture.cleanup(); }
});
it('refuses symlink source content before creating a candidate worktree', () => {
  const fixture = worktreeFixture();
  try {
    symlinkSync('/etc/passwd', join(fixture.source, 'link')); localGit(fixture.source, ['add', 'link']); localGit(fixture.source, ['commit', '-qm', 'link']);
    const commit = localGit(fixture.source, ['rev-parse', 'HEAD']);
    const pool = new LocalWorktreePool(fixture.source, fixture.root);
    expect(() => pool.create({ taskId: 'task', workerId: 'worker', commit })).toThrow('Symlinks');
    expect(localGit(fixture.source, ['worktree', 'list', '--porcelain']).match(/^worktree /gm)).toHaveLength(1);
  } finally { fixture.cleanup(); }
});
it.each(['include.path', 'filter.test.smudge', 'credential.helper'] as const)('refuses indirect/executable config %s without invoking it', key => {
  const fixture = worktreeFixture();
  try {
    localGit(fixture.source, ['config', key, 'never-execute-this']);
    expect(() => new LocalWorktreePool(fixture.source, fixture.root)).toThrow('configuration');
  } finally { fixture.cleanup(); }
});
it('suppresses repository checkout hooks and source worktree mutations', () => {
  const fixture = worktreeFixture();
  try {
    const marker = join(fixture.root, 'hook-ran');
    writeFileSync(join(fixture.source, '.git/hooks/post-checkout'), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o700 });
    const config = readFileSync(join(fixture.source, '.git/config'), 'utf8');
    const pool = new LocalWorktreePool(fixture.source, fixture.root);
    const lease = pool.create({ taskId: 'task', workerId: 'worker', commit: fixture.commit });
    expect(existsSync(marker)).toBe(false);
    pool.release(lease.id);
    expect(readFileSync(join(fixture.source, '.git/config'), 'utf8')).toBe(config);
  } finally { fixture.cleanup(); }
});
it('refuses source symlinks and request path injection', () => {
  const fixture = worktreeFixture();
  try {
    const alias = join(fixture.root, 'alias'); symlinkSync(fixture.source, alias);
    expect(() => new LocalWorktreePool(alias, fixture.root)).toThrow('canonical');
    const pool = new LocalWorktreePool(fixture.source, fixture.root);
    expect(() => pool.create({ taskId: '../outside', workerId: 'worker', commit: fixture.commit })).toThrow('identity');
    expect(() => pool.create({ taskId: 'task', workerId: 'worker', commit: fixture.commit, directory: fixture.source } as Parameters<typeof pool.create>[0])).toThrow('field');
  } finally { fixture.cleanup(); }
});
it('refuses submodule gitlinks before materialization', () => {
  const fixture = worktreeFixture();
  try {
    localGit(fixture.source, ['update-index', '--add', '--cacheinfo', `160000,${fixture.commit},submodule`]);
    localGit(fixture.source, ['commit', '-qm', 'gitlink']);
    const pool = new LocalWorktreePool(fixture.source, fixture.root);
    expect(() => pool.create({ taskId: 'task', workerId: 'worker', commit: localGit(fixture.source, ['rev-parse', 'HEAD']) })).toThrow('submodules');
  } finally { fixture.cleanup(); }
});
it.each(['case-collision', 'large-blob'] as const)('rejects %s trees before allocation', kind => {
  const fixture = worktreeFixture();
  try {
    if (kind === 'case-collision') { writeFileSync(join(fixture.source, 'Readme'), 'one'); writeFileSync(join(fixture.source, 'readme'), 'two'); }
    else writeFileSync(join(fixture.source, 'large'), Buffer.alloc(1048577));
    localGit(fixture.source, ['add', '.']); localGit(fixture.source, ['commit', '-qm', kind]);
    const pool = new LocalWorktreePool(fixture.source, fixture.root);
    expect(() => pool.create({ taskId: 'task', workerId: 'worker', commit: localGit(fixture.source, ['rev-parse', 'HEAD']) })).toThrow();
    expect(localGit(fixture.source, ['worktree', 'list', '--porcelain']).match(/^worktree /gm)).toHaveLength(1);
  } finally { fixture.cleanup(); }
});
it('preserves candidate commits even after restoring original file bytes', () => {
  const fixture = worktreeFixture();
  try {
    const pool = new LocalWorktreePool(fixture.source, fixture.root);
    const lease = pool.create({ taskId: 'task', workerId: 'worker', commit: fixture.commit });
    localGit(lease.directory, ['commit', '--allow-empty', '-qm', 'candidate']);
    expect(() => pool.release(lease.id)).toThrow('commits');
    expect(existsSync(lease.directory)).toBe(true);
  } finally { fixture.cleanup(); }
});
it('does not clean staged-only candidate changes and records uncertain cleanup', () => {
  const fixture = worktreeFixture();
  try {
    const pool = new LocalWorktreePool(fixture.source, fixture.root);
    const lease = pool.create({ taskId: 'task', workerId: 'worker', commit: fixture.commit });
    writeFileSync(join(lease.directory, 'src/file.txt'), 'candidate'); localGit(lease.directory, ['add', 'src/file.txt']);
    writeFileSync(join(lease.directory, 'src/file.txt'), 'original\n');
    expect(() => pool.release(lease.id)).toThrow('uncertain');
    expect(pool.inspect(lease.id)?.state).toBe('quarantined');
    expect(localGit(lease.directory, ['show', ':src/file.txt'])).toBe('candidate');
  } finally { fixture.cleanup(); }
});
it('does not let Git replace refs change the materialization behind an exact commit SHA', () => {
  const fixture = worktreeFixture();
  try {
    writeFileSync(join(fixture.source, 'src/file.txt'), 'replacement\n');
    localGit(fixture.source, ['add', '.']); localGit(fixture.source, ['commit', '-qm', 'replacement']);
    const replacement = localGit(fixture.source, ['rev-parse', 'HEAD']);
    localGit(fixture.source, ['replace', fixture.commit, replacement]);
    expect(localGit(fixture.source, ['show', `${fixture.commit}:src/file.txt`])).toBe('replacement');
    const pool = new LocalWorktreePool(fixture.source, fixture.root);
    const lease = pool.create({ taskId: 'task', workerId: 'worker', commit: fixture.commit });
    expect(lease.commit).toBe(fixture.commit);
    expect(readFileSync(join(lease.directory, 'src/file.txt'), 'utf8')).toBe('original\n');
    expect(pool.release(lease.id).state).toBe('released');
  } finally { fixture.cleanup(); }
});
it('rejects executable config added to a candidate-specific worktree config before cleanup', () => {
  const fixture = worktreeFixture();
  try {
    localGit(fixture.source, ['config', 'extensions.worktreeConfig', 'true']);
    writeFileSync(join(fixture.source, '.gitattributes'), 'src/file.txt filter=unsafe\n');
    localGit(fixture.source, ['add', '.']); localGit(fixture.source, ['commit', '-qm', 'attributes']);
    const pool = new LocalWorktreePool(fixture.source, fixture.root);
    const lease = pool.create({ taskId: 'task', workerId: 'worker', commit: localGit(fixture.source, ['rev-parse', 'HEAD']) });
    const marker = join(fixture.root, 'filter-ran');
    localGit(lease.directory, ['config', '--worktree', 'filter.unsafe.clean', `touch ${marker}`]);
    expect(() => pool.release(lease.id)).toThrow('configuration');
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(lease.directory)).toBe(true);
  } finally { fixture.cleanup(); }
});
