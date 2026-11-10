import {it,expect} from 'vitest';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createReport,sha256,writeReportExclusive} from '../../packages/observability/src/index.ts';
const input={runId:'offline-1',taskId:'M0-04',evaluatedCommit:'a'.repeat(40),benchmarkVersion:'T0-v1',environmentDigest:sha256('node24'),checks:[{name:'fixture',passed:true,evidencePath:'fixture.json'}],artifactHashes:{'fixture.json':sha256('{}')}};
it('reports actual checks, never product success',()=>{expect(createReport(input)).toMatchObject({passed:true,productClaim:'NOT_VERIFIED',evidenceKind:'offline-fixture'}); expect(createReport({...input,checks:[{...input.checks[0]!,passed:false}]}).passed).toBe(false);});
it('rejects empty checks, missing evidence, abbreviated commit',()=>{expect(()=>createReport({...input,checks:[]})).toThrow(); expect(()=>createReport({...input,artifactHashes:{}})).toThrow(); expect(()=>createReport({...input,evaluatedCommit:'abc'})).toThrow();});
it('never overwrites an existing report',()=>{const dir=mkdtempSync(join(tmpdir(),'forge-report-'));try { const path=join(dir,'report.json');writeReportExclusive(path,createReport(input)); const before=readFileSync(path,'utf8');expect(()=>writeReportExclusive(path,createReport(input))).toThrow();expect(readFileSync(path,'utf8')).toBe(before);}finally{rmSync(dir,{recursive:true});}});

it('rejects runtime malformed outcomes and environment digests',()=>{expect(()=>createReport({...input,environmentDigest:'not-a-hash'})).toThrow(); expect(()=>createReport({...input,checks:[{name:'false-string',passed:'false' as unknown as boolean,evidencePath:'fixture.json'}]})).toThrow();});
