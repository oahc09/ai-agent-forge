#!/usr/bin/env node
import {readFileSync, writeFileSync} from 'node:fs';
import {defaultPolicy, parsePolicy} from '../../../packages/policy/src/index.ts';
export function main(args: string[]): object {
  const [command, path] = args.filter(arg=>arg !== '--json');
  if (command === 'init') {
    if (!path) throw new Error('Usage: forge init <policy.json> [--json]');
    writeFileSync(path, JSON.stringify(defaultPolicy(),null,2)+'\n',{flag:'wx',mode:0o600});
    return {initialized:path, observeOnly:true, phase:'M0', nextGate:'G0 human baseline review'};
  }
  if (command === 'doctor') {
    if (!path) throw new Error('Usage: forge doctor <policy.json> [--json]');
    const policy = parsePolicy(JSON.parse(readFileSync(path,'utf8')) as unknown);
    return {configurationValid:true, policy, runtimeReady:false, missing:['M1 event store and scheduler','M2 sandbox and real adapters'], gate:'NOT_VERIFIED'};
  }
  throw new Error('M0 commands: init <policy.json>, doctor <policy.json>. Runtime commands are not implemented.');
}
try { process.stdout.write(JSON.stringify(main(process.argv.slice(2)),null,2)+'\n'); }
catch(error) { process.stderr.write(JSON.stringify({error:error instanceof Error ? error.message : 'Unknown error'})+'\n'); process.exitCode=1; }
