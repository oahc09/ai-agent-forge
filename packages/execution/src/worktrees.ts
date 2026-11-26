import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants, lstatSync, fstatSync, readSync, readdirSync, realpathSync, mkdirSync, mkdtempSync, openSync, closeSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { CandidateWorkspace } from './candidate-workspace.ts';

export class WorktreeError extends Error {
  constructor(message: string) { super(message); this.name = 'WorktreeError'; }
}
interface TrackedFile { path: string; mode: number; sha256: string; size: number }
export interface WorktreeLease {
  id: string; taskId: string; workerId: string; commit: string; directory: string;
  state: 'creating' | 'ready' | 'quarantined' | 'released';
  isolation: 'worktree-only-not-os-sandbox';
}
interface OwnedLease { lease: WorktreeLease; files: TrackedFile[]; gitMarker: string | null }
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function check(ok: unknown, message: string): asserts ok { if (!ok) throw new WorktreeError(message); }
function regular(path: string, limit: number): Buffer {
  const stat = lstatSync(path);
  check(stat.isFile() && !stat.isSymbolicLink() && stat.size <= limit, 'Expected bounded regular file');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const current = fstatSync(fd);
    check(current.isFile() && current.size <= limit && current.dev === stat.dev && current.ino === stat.ino, 'File changed during inspection');
    const bytes = Buffer.alloc(current.size + 1);
    let length = 0, read = 0;
    while (length < bytes.length && (read = readSync(fd, bytes, length, bytes.length - length, null)) > 0) length += read;
    check(length === current.size, 'File size changed during inspection');
    return bytes.subarray(0, length);
  } finally { closeSync(fd); }
}
function canonicalDirectory(path: string): string {
  check(isAbsolute(path), 'Absolute host-selected path required');
  const canonical = realpathSync(path);
  check(canonical === resolve(path) && lstatSync(path).isDirectory(), 'Directory must be canonical, without symlinks');
  return canonical;
}
function safeRelative(path: string): void {
  check(path.length > 0 && path.length <= 4096 && /^[A-Za-z0-9._@+/-]+$/.test(path), 'Unsupported repository path');
  check(!isAbsolute(path) && path.split('/').every(part => part && part !== '.' && part !== '..' && part.toLowerCase() !== '.git' && !part.endsWith('.')), 'Unsafe repository path');
}
function gitDirectories(source: string): { git: string; common: string } {
  const marker = join(source, '.git');
  const stat = lstatSync(marker); check(!stat.isSymbolicLink(), 'Symlink Git metadata refused');
  const git = stat.isDirectory() ? canonicalDirectory(marker) : (() => {
    const line = regular(marker, 4096).toString('utf8');
    check(/^gitdir: [^\r\n]+\n?$/.test(line), 'Invalid Git worktree marker');
    return canonicalDirectory(resolve(source, line.slice(8).trim()));
  })();
  let common = git;
  try { common = canonicalDirectory(resolve(git, regular(join(git, 'commondir'), 4096).toString('utf8').trim())); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return { git, common };
}
/** Trusted-host local workspace allocation, NOT a security boundary. Never run
 * untrusted agents with this module alone. OS isolation remains independently required. */
export class LocalWorktreePool {
  private readonly rootPath: string;
  private readonly rootDevice: number;
  private readonly rootInode: number;
  get root(): string { return this.rootPath; }
  private readonly source: string;
  private readonly metadata: { git: string; common: string };
  private exports = 0;
  private readonly leases = new Map<string, OwnedLease>();
  constructor(source: string, parent = tmpdir()) {
    this.source = canonicalDirectory(source); this.metadata = gitDirectories(this.source);
    this.inspectConfiguration();
    this.rootPath = mkdtempSync(join(canonicalDirectory(parent), 'forge-worktrees-'));
    const stat = lstatSync(this.rootPath); this.rootDevice = stat.dev; this.rootInode = stat.ino;
  }
  private inspectConfiguration(candidate?: string): void {
    const current = gitDirectories(this.source);
    check(current.git === this.metadata.git && current.common === this.metadata.common, 'Source Git metadata moved');
    const configs = new Set([join(current.common, 'config'), join(current.git, 'config.worktree'), join(current.common, 'config.worktree')]);
    if (candidate) {
      canonicalDirectory(candidate);
      const extra = gitDirectories(candidate);
      check(extra.common === current.common, 'Foreign candidate Git metadata');
      configs.add(join(extra.git, 'config.worktree'));
    }
    for (const path of configs) {
      try {
        const config = regular(path, 65536).toString('utf8');
        // Refuse config indirection and conversion commands before invoking Git.
        // This conservative trusted-host check is not a race-proof config sandbox.
        check(!/\\|\[\s*(?:include|includeif|filter|alias|credential)\b/i.test(config), 'Unsupported executable or indirect Git configuration');
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
  private git(args: string[], cwd = this.source, maxBuffer = 2097152): Buffer {
    this.inspectConfiguration(cwd === this.source ? undefined : cwd);
    try {
      return execFileSync('git', [
        '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.attributesFile=/dev/null',
        '-c', 'core.sparseCheckout=false', '-c', 'protocol.allow=never', ...args,
      ], { cwd, encoding: 'buffer', maxBuffer, timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'],
        env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '', GIT_OPTIONAL_LOCKS: '0' } });
    } catch { throw new WorktreeError('Local Git operation failed; inspect the retained lease, not untrusted stderr'); }
  }
  private checkRoot(): void {
    canonicalDirectory(this.root);
    const stat = lstatSync(this.root);
    check(stat.dev === this.rootDevice && stat.ino === this.rootInode, 'Worktree pool root changed');
  }
  private persist(record: OwnedLease): void {
    this.checkRoot();
    const target = join(this.root, `${record.lease.id}.json`);
    const temporary = `${target}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(record, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    renameSync(temporary, target);
  }
  create(request: { taskId: string; workerId: string; commit: string }): WorktreeLease {
    this.checkRoot();
    check(Object.keys(request).sort().join(',') === 'commit,taskId,workerId', 'Unexpected worktree request field');
    for (const id of [request.taskId, request.workerId]) check(typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id), 'Invalid lease identity');
    check(/^[a-f0-9]{40}$/.test(request.commit), 'An exact commit SHA is required');
    check(this.leases.size < 1000, 'Worktree pool history limit reached');
    const active = [...this.leases.values()].filter(record => record.lease.state !== 'released');
    check(active.length < 32 && !active.some(record => record.lease.taskId === request.taskId || record.lease.workerId === request.workerId), 'Task, worker or capacity already reserved');
    check(this.git(['cat-file', '-t', request.commit]).toString().trim() === 'commit', 'Expected commit object');
    const entries = this.git(['ls-tree', '-rlz', request.commit]).toString('utf8').split('\0').filter(Boolean).map(line => {
      const match = /^(100644|100755) blob ([a-f0-9]{40})\s+(\d+)\t(.+)$/.exec(line);
      check(match, 'Symlinks, submodules and nonregular tree entries are refused');
      const path = match[4]!; safeRelative(path);
      const size = Number(match[3]); check(Number.isSafeInteger(size) && size <= 1048576, 'Repository blob too large');
      return { path, oid: match[2]!, size, mode: match[1] === '100755' ? 0o755 : 0o644 };
    });
    check(entries.length <= 10000 && entries.reduce((sum, entry) => sum + entry.size, 0) <= 16777216, 'Worktree materialization limit exceeded');
    check(new Set(entries.map(entry => entry.path.toLowerCase())).size === entries.length, 'Case-colliding paths refused');
    const id = randomUUID();
    const record: OwnedLease = { lease: { ...request, id, directory: join(this.root, id), state: 'creating', isolation: 'worktree-only-not-os-sandbox' }, files: [], gitMarker: null };
    this.leases.set(id, record); this.persist(record);
    try {
      // --no-checkout avoids smudge filters and checkout hooks. Materialize raw
      // blobs ourselves; read-tree only builds the separate worktree index.
      this.git(['worktree', 'add', '--detach', '--no-checkout', '--lock', '--reason', `AgentForge ${id}`, '--', record.lease.directory, request.commit]);
      record.gitMarker = regular(join(record.lease.directory, '.git'), 4096).toString('utf8');
      this.git(['read-tree', request.commit], record.lease.directory);
      for (const entry of entries) {
        const bytes = this.git(['cat-file', 'blob', entry.oid], this.source, 1048577);
        check(bytes.length === entry.size, 'Blob size changed');
        const path = join(record.lease.directory, entry.path);
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        // Only fresh paths created by this host are written. Same-UID concurrent
        // mutation is outside this boundary and needs the missing OS sandbox.
        const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, entry.mode);
        try { writeFileSync(fd, bytes); } finally { closeSync(fd); }
        record.files.push({ path: entry.path, mode: lstatSync(path).mode & 0o777, size: entry.size, sha256: hash(bytes) });
      }
      record.lease.state = 'ready'; this.persist(record);
      return structuredClone(record.lease);
    } catch {
      record.lease.state = 'quarantined'; this.persist(record);
      throw new WorktreeError(`Worktree ${id} retained for inspection after creation failure`);
    }
  }
  inspect(id: string): WorktreeLease | null { return structuredClone(this.leases.get(id)?.lease ?? null); }
  /** Copy a verified pristine lease into fresh regular files without .git or
   * shared Git metadata. Still requires an independent OS sandbox before execution. */
  detach(id: string): CandidateWorkspace {
    this.checkRoot();
    const record = this.leases.get(id);
    check(record && record.lease.state === 'ready', 'Only an owned ready lease can be detached');
    check(this.exports < 32, 'Detached workspace history limit reached');
    this.assertPristine(record);
    const files = record.files.map(file => {
      const bytes = regular(join(record.lease.directory, file.path), 1048576);
      check(hash(bytes) === file.sha256, 'Baseline changed during export');
      return { path: file.path, mode: file.mode, bytes };
    });
    this.exports++;
    return new CandidateWorkspace(this.root, { leaseId: id, taskId: record.lease.taskId,
      workerId: record.lease.workerId, commit: record.lease.commit }, files);
  }
  private assertPristine(record: OwnedLease): void {
    check(canonicalDirectory(record.lease.directory) === record.lease.directory, 'Worktree directory moved');
    check(regular(join(record.lease.directory, '.git'), 4096).toString('utf8') === record.gitMarker, 'Git worktree marker changed');
    check(this.git(['rev-parse', 'HEAD'], record.lease.directory).toString().trim() === record.lease.commit, 'Candidate commits must be preserved');
    const files = new Map(record.files.map(file => [file.path, file]));
    const directories = new Set<string>();
    for (const file of record.files) {
      let directory = dirname(file.path);
      while (directory !== '.') { directories.add(directory); directory = dirname(directory); }
    }
    const visit = (directory: string) => {
      for (const entry of readdirSync(directory)) {
        const path = join(directory, entry); const local = relative(record.lease.directory, path);
        if (local === '.git') continue;
        const stat = lstatSync(path); check(!stat.isSymbolicLink(), 'Symlink changes must be preserved');
        if (stat.isDirectory()) { check(directories.has(local), 'Untracked directories must be preserved'); visit(path); continue; }
        const expected = files.get(local);
        check(expected && stat.isFile() && stat.size === expected.size && (stat.mode & 0o777) === expected.mode, 'Untracked or changed files must be preserved');
        check(hash(regular(path, 1048576)) === expected.sha256, 'Changed file contents must be preserved');
        files.delete(local);
      }
    };
    visit(record.lease.directory); check(files.size === 0, 'Deleted files must be preserved');
  }
  /** Never force-remove or discard candidate/user changes. An interrupted process
   * leaves manifests and Git worktree registrations for manual reconciliation. */
  release(id: string): WorktreeLease {
    this.checkRoot();
    const record = this.leases.get(id);
    check(record && record.lease.state === 'ready', 'Only an owned ready lease can be released');
    this.assertPristine(record);
    try {
      this.inspectConfiguration(record.lease.directory);
      this.git(['worktree', 'unlock', '--', record.lease.directory]);
      this.git(['worktree', 'remove', '--', record.lease.directory]);
      record.lease.state = 'released'; this.persist(record); return structuredClone(record.lease);
    } catch {
      record.lease.state = 'quarantined'; this.persist(record);
      throw new WorktreeError(`Worktree ${id} cleanup uncertain; retained for inspection`);
    }
  }
}
