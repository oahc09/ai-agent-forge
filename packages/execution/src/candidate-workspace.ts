import { createHash } from 'node:crypto';
import { constants, closeSync, fchmodSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readSync, opendirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export interface CandidateIdentity { leaseId: string; taskId: string; workerId: string; commit: string }
export interface CandidateFile { path: string; size: number; mode: number; sha256: string }
export interface CandidateChange { path: string; kind: 'added' | 'modified' | 'deleted'; before: CandidateFile | null; after: CandidateFile | null }
export interface CandidateInventory {
  identity: CandidateIdentity; baselineDigest: string; candidateDigest: string;
  files: CandidateFile[]; directories: string[]; changes: CandidateChange[];
  isolationVerified: false; applied: false;
}
export class CandidateWorkspaceError extends Error {
  constructor() { super('Candidate workspace inspection refused; preserve workspace for host review'); this.name = 'CandidateWorkspaceError'; }
}
function check(value: unknown): asserts value { if (!value) throw new CandidateWorkspaceError(); }
const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const sort = <T extends { path: string }>(values: T[]): T[] => values.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
function safePath(path: string): void {
  check(typeof path === 'string' && path.length > 0 && path.length <= 4096 && /^[A-Za-z0-9._@+/-]+$/.test(path));
  check(!isAbsolute(path) && path.split('/').every(p => p && p !== '.' && p !== '..' && p.toLowerCase() !== '.git' && !p.endsWith('.')));
}
function directory(path: string): void { check(isAbsolute(path) && resolve(path) === path && realpathSync(path) === path && lstatSync(path).isDirectory()); }
function boundedRead(path: string): Buffer {
  const prior = lstatSync(path);
  check(prior.isFile() && prior.nlink === 1 && prior.size <= 1048576);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    check(stat.isFile() && stat.nlink === 1 && stat.size <= 1048576 && stat.dev === prior.dev && stat.ino === prior.ino);
    const bytes = Buffer.alloc(stat.size + 1);
    let length = 0, count = 0;
    while (length < bytes.length && (count = readSync(fd, bytes, length, bytes.length - length, null)) > 0) length += count;
    check(length === stat.size);
    const after = fstatSync(fd);
    check(after.size === stat.size && after.mtimeMs === stat.mtimeMs && after.ctimeMs === stat.ctimeMs);
    return bytes.subarray(0, length);
  } finally { closeSync(fd); }
}
/** Trusted-host data transport, NOT a sandbox or authorization mechanism. Public
 * constructor accepts a host-supplied baseline; use LocalWorktreePool.detach for
 * a baseline verified against that pool's exact immutable commit. Never call this
 * with model-generated identity or arbitrary files and claim Git verification. */
export class CandidateWorkspace {
  private readonly path: string;
  private readonly device: number;
  private readonly inode: number;
  private readonly identity: CandidateIdentity;
  private readonly baseline: CandidateFile[];
  private readonly baselineDigest: string;
  get directory(): string { return this.path; }
  constructor(parent: string, identity: CandidateIdentity, files: { path: string; mode: number; bytes: Buffer }[]) {
    directory(parent);
    check(Object.keys(identity).sort().join(',') === 'commit,leaseId,taskId,workerId');
    check(/^[a-f0-9]{40}$/.test(identity.commit));
    for (const id of [identity.leaseId, identity.taskId, identity.workerId]) check(typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id));
    check(Array.isArray(files) && files.length <= 10000);
    let total = 0;
    const paths = new Map<string, string>();
    for (const file of files) {
      safePath(file.path); check(Number.isInteger(file.mode) && file.mode >= 0 && file.mode <= 0o755 && (file.mode & ~0o755) === 0);
      check(Buffer.isBuffer(file.bytes) && file.bytes.length <= 1048576);
      total += file.bytes.length; check(total <= 16777216);
      const parts = file.path.split('/'); check(parts.length <= 65);
      for (let i = 1; i <= parts.length; i++) {
        const path = parts.slice(0, i).join('/'), key = path.toLowerCase();
        check(!paths.has(key) || paths.get(key) === path); paths.set(key, path); check(paths.size <= 20000);
      }
    }
    check(new Set(files.map(f => f.path)).size === files.length);
    const filePaths = new Set(files.map(f => f.path));
    for (const path of paths.values()) check(!filePaths.has(dirname(path)));
    this.identity = structuredClone(identity);
    this.path = mkdtempSync(join(parent, 'candidate-'));
    const stat = lstatSync(this.path); this.device = stat.dev; this.inode = stat.ino;
    this.baseline = [];
    // Fresh regular copies, never hard links or symlinks. No Git process, index,
    // marker, hooks, object directory, host environment or credentials exported.
    for (const file of files) {
      const path = join(this.path, file.path);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { writeFileSync(fd, file.bytes); fchmodSync(fd, file.mode); } finally { closeSync(fd); }
      this.baseline.push({ path: file.path, mode: lstatSync(path).mode & 0o777, size: file.bytes.length, sha256: digest(file.bytes) });
    }
    sort(this.baseline);
    this.baselineDigest = digest(JSON.stringify({ identity: this.identity, files: this.baseline }));
  }
  /** Call only after the runner has stopped and the trusted host owns exclusive
   * access. Hash metadata only; does not execute, stage, apply, delete or upload. */
  inspect(): CandidateInventory {
    try {
      directory(this.path);
      const root = lstatSync(this.path); check(root.dev === this.device && root.ino === this.inode);
      const files: CandidateFile[] = [], directories: string[] = [], names = new Set<string>();
      let entries = 0, total = 0;
      const visit = (local: string, depth: number): void => {
        check(depth <= 64);
        const base = join(this.path, local);
        const handle = opendirSync(base);
        try {
          let entry;
          while ((entry = handle.readSync()) !== null) {
            const name = entry.name;
            const path = local ? `${local}/${name}` : name; safePath(path);
            check(++entries <= 20000 && !names.has(path.toLowerCase())); names.add(path.toLowerCase());
            const full = join(this.path, path), stat = lstatSync(full);
            check(!stat.isSymbolicLink() && stat.dev === this.device);
            if (stat.isDirectory()) { directories.push(path); visit(path, depth + 1); continue; }
            check(stat.isFile() && stat.nlink === 1 && (stat.mode & 0o7000) === 0 && files.length < 10000);
            const bytes = boundedRead(full); total += bytes.length; check(total <= 16777216);
            files.push({ path, size: bytes.length, mode: stat.mode & 0o777, sha256: digest(bytes) });
          }
        } finally { handle.closeSync(); }
      };
      visit('', 0); sort(files); directories.sort();
      const before = new Map(this.baseline.map(file => [file.path, file])), changes: CandidateChange[] = [];
      for (const file of files) {
        const original = before.get(file.path); before.delete(file.path);
        if (!original || original.sha256 !== file.sha256 || original.mode !== file.mode) changes.push({ path: file.path, kind: original ? 'modified' : 'added', before: original ?? null, after: file });
      }
      for (const file of before.values()) changes.push({ path: file.path, kind: 'deleted', before: file, after: null });
      return structuredClone({ identity: this.identity, baselineDigest: this.baselineDigest,
        candidateDigest: digest(JSON.stringify({ identity: this.identity, files, directories })), files, directories,
        changes: sort(changes), isolationVerified: false, applied: false });
    } catch { throw new CandidateWorkspaceError(); }
  }
}
