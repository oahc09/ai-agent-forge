import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

const executables = ['codex', 'opencode', 'pi', 'bwrap'] as const;
/** Inventory only: never execute PATH entries, inspect credentials, or probe isolation.
 * Presence is neither an authorization nor evidence that an adapter/sandbox works. */
export function readinessReport(searchPath = process.env.PATH ?? '') {
  const directories = [...new Set(searchPath.split(delimiter).filter(isAbsolute))];
  const inventory = executables.map(name => {
    let present = false;
    let inaccessible = false;
    for (const directory of directories) {
      try {
        const candidate = join(directory, name);
        if (!statSync(candidate).isFile()) continue;
        accessSync(candidate, constants.X_OK);
        present = true;
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && code !== 'ENOTDIR') inaccessible = true;
      }
    }
    return { name, availability: present ? 'PRESENT' : inaccessible ? 'UNKNOWN' : 'NOT_FOUND',
      version: 'NOT_INSPECTED', executionVerified: false };
  });
  return {
    schemaVersion: 1, mode: 'read-only-inventory', platform: process.platform,
    nodeVersion: process.version, inventory,
    productionReady: false, gate: { id: 'G2', status: 'NOT_VERIFIED' },
    providerAccess: 'NOT_INSPECTED', providerCost: 'NOT_MEASURED',
    sandbox: { status: 'NOT_PROBED', isolationVerified: false },
    blockers: [
      { id: 'REAL_ADAPTERS', taskIds: ['M2-02', 'M2-03'],
        nextStep: 'Implement and independently validate two heterogeneous real adapter transports; installed binaries and native host roles are not adapters.' },
      { id: 'PROVIDER_AUTHORIZATION', taskIds: ['M2-02', 'M2-03'],
        nextStep: 'Obtain explicit executor/provider, account, model and per-task/daily/total budget authorization before real calls. This inventory does not inspect or grant authorization.' },
      { id: 'OS_ISOLATION', taskIds: ['M2-04'],
        nextStep: 'Use an authorized runtime with verified filesystem/process/network/resource isolation. Do not retry a denied probe, relax security or switch environments without required approval.' },
      { id: 'REAL_EVIDENCE', taskIds: ['M2-02', 'M2-03', 'M2-04'],
        nextStep: 'After prerequisites pass, record ten shared real tasks, independent results, version/cost/error/cancellation/recovery and isolation evidence. Fixtures cannot satisfy G2.' },
    ],
    limitations: ['Absolute PATH directories only; executable presence is not trust or usability.',
      'No binaries launched, credentials read, network calls made, state database opened, or gates changed.'],
  };
}
