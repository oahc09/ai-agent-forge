import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

interface BaselineFile {
  path: string;
  text: string;
  sha256: string;
}

interface PreflightCase {
  id: string;
  category: string;
  request: string;
  editablePaths: string[];
  baseline: BaselineFile[];
  hostReview: string[];
}

interface PublicPreflightCorpus {
  schemaVersion: number;
  id: string;
  status: string;
  originalManifestSha256: string;
  cases: PreflightCase[];
}

const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');
const fixtureBytes = readFileSync(new URL('../../fixtures/g2-adapter-preflight/cases.json', import.meta.url));
const corpus = JSON.parse(fixtureBytes.toString('utf8')) as PublicPreflightCorpus;
const safePath = /^(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.(?:md|mjs|test\.mjs)$/u;

describe('G2 public preflight corpus (no provider or candidate execution)', () => {
  it('pins the published bytes separately from the unchanged original benchmark', () => {
    const original = readFileSync(new URL('../../docs/benchmark-manifest.yaml', import.meta.url));
    expect(sha256(original)).toBe('90cf4136531cc4966956cf53ad814380d7cfd47002cbe0edc170fb93ddbe2849');
    expect(corpus.originalManifestSha256).toBe(sha256(original));
    expect(sha256(fixtureBytes)).toBe('d79130fdeba29572a18131d0322e430467cdfd314ef3ccf36c570146a18949fc');
    expect(corpus.id).toBe('g2-adapter-preflight-v1');
    expect(corpus.schemaVersion).toBe(1);
    expect(corpus.status).toBe('planned-not-executed');
  });

  it('contains exactly two examples per original pilot category with unique IDs', () => {
    expect(corpus.cases).toHaveLength(10);
    expect(new Set(corpus.cases.map((item) => item.id)).size).toBe(10);
    const counts: Record<string, number> = {};
    for (const item of corpus.cases) counts[item.category] = (counts[item.category] ?? 0) + 1;
    expect(counts).toEqual({ documentation: 2, 'unit-tests': 2, bugfix: 2, 'adapter-api': 2, 'multi-file': 2 });
  });

  it.each(corpus.cases)('$id has reproducible input in both independent copies', (item) => {
    const baselinePaths = item.baseline.map((file) => file.path);
    const allPaths = [...new Set([...baselinePaths, ...item.editablePaths])];
    expect(allPaths.every((path) => safePath.test(path))).toBe(true);
    expect(new Set(allPaths.map((path) => path.toLowerCase())).size).toBe(allPaths.length);
    expect(new Set(baselinePaths).size).toBe(baselinePaths.length);
    expect(new Set(item.editablePaths).size).toBe(item.editablePaths.length);
    expect(item.editablePaths).toHaveLength(item.category === 'multi-file' ? 2 : 1);
    expect(item.request.trim()).not.toBe('');
    expect(item.hostReview.length).toBeGreaterThan(0);
    expect(item.hostReview.every((line) => line.trim().length > 0)).toBe(true);

    const temp = mkdtempSync(join(tmpdir(), 'forge-public-g2-'));
    try {
      const pair = [join(temp, 'lane-a'), join(temp, 'lane-b')];
      for (const root of pair) {
        for (const file of item.baseline) {
          expect(sha256(file.text)).toBe(file.sha256);
          const target = join(root, file.path);
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, file.text, { encoding: 'utf8', flag: 'wx' });
          expect(sha256(readFileSync(target))).toBe(file.sha256);
        }
      }
      // Mutation is test-owned. Verify that editing one input does not change the other.
      const file = item.baseline[0]!;
      writeFileSync(join(pair[0]!, file.path), 'isolated test marker\n');
      expect(sha256(readFileSync(join(pair[0]!, file.path)))).not.toBe(file.sha256);
      expect(sha256(readFileSync(join(pair[1]!, file.path)))).toBe(file.sha256);
    } finally {
      rmSync(temp, { recursive: true });
    }
  });
});
