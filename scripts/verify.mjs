import {spawnSync,execFileSync} from 'node:child_process';
import {mkdirSync,writeFileSync,readFileSync,copyFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {createReport,sha256,writeReportExclusive} from '../packages/observability/src/index.ts';
const runId=randomUUID(); const dir=`artifacts/M0/${runId}`; mkdirSync(dir,{recursive:true});
const checks=[]; const artifactHashes={}; const tests=[];
function save(name,value){const bytes=typeof value==='string'?value:JSON.stringify(value,null,2)+'\n';writeFileSync(`${dir}/${name}`,bytes);artifactHashes[name]=sha256(bytes);}
const evaluatedCommit=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
const environment={node:process.version,platform:process.platform,arch:process.arch,pnpm:execFileSync('pnpm',['--version'],{encoding:'utf8'}).trim(),evaluatedCommit,dirty:execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim().length>0,lockSha256:sha256(readFileSync('pnpm-lock.yaml'))};
save('environment.json',environment);
save('diff.patch',execFileSync('git',['diff','d5f4fa53aeae23f484cc06f2d4387d8f7fdf9d76','--'],{encoding:'utf8'}));
for(const command of ['lint','typecheck','test','test:security','build']){
 const start=Date.now();const result=spawnSync('pnpm',[command],{encoding:'utf8',env:process.env});
 const path=`${command.replace(':','-')}.log`;const log=(result.stdout??'')+(result.stderr??'')+(result.error?.message??'');
 save(path,log);checks.push({name:command,passed:result.status===0,evidencePath:path});
 tests.push({command:`pnpm ${command}`,exitCode:result.status,signal:result.signal,durationMs:Date.now()-start,log:path});process.stdout.write(log);
}
save('tests.json',tests);
save('policy.json',{scope:'M0 bootstrap implementation verification only',remoteActions:[],modelCalls:0,merged:false,deployed:false,authority:'User requested development and submission to oahc09/ai-agent-forge; active product grants remain disabled'});
save('cost.json',{modelCalls:0,providerChargesUsd:0,source:'Verification scripts invoke no model provider; assistant development service costs are not measured here'});
save('plan.md','Verify M0 baseline: lint, strict types, offline unit/security/CLI tests and build. No later Gate or actual autonomy claim.\n');
save('review.md','Independent review is required for completion. See docs/m0-independent-review.md if present. This generated report does not impersonate a reviewer or grant G0 approval.\n');
save('report.md',`# M0 offline verification\n\nCommit: ${evaluatedCommit}\nDirty: ${environment.dirty}\nAutomated checks: ${checks.every(c=>c.passed)?'PASS':'FAIL'}\nHuman G0 baseline review: NOT_VERIFIED\nG1–G8: NOT_VERIFIED\nReproduce: pnpm install --frozen-lockfile && pnpm verify\n`);
const tasks=JSON.parse(readFileSync('backlog.json','utf8')).tasks.filter(t=>t.milestone==='M0');
for(const task of tasks){
 const taskDir=`artifacts/${task.id}/${runId}`;mkdirSync(taskDir,{recursive:true});
 const hashes={...artifactHashes}; for(const name of Object.keys(hashes))copyFileSync(`${dir}/${name}`,`${taskDir}/${name}`);
 const taskBytes=JSON.stringify({...task,status:'NOT_VERIFIED',automatedChecks:checks.every(c=>c.passed)?'PASS':'FAIL',remaining:['Independent review','Human G0 approval']},null,2)+'\n';writeFileSync(`${taskDir}/task.json`,taskBytes);hashes['task.json']=sha256(taskBytes);
 writeReportExclusive(`${taskDir}/report.json`,createReport({runId,taskId:task.id,evaluatedCommit,benchmarkVersion:'T0-m0-v1',environmentDigest:artifactHashes['environment.json'],checks,artifactHashes:hashes}));
}
save('task.json',{taskId:'M0',scope:tasks.map(t=>t.id),status:'NOT_VERIFIED'});
const report=createReport({runId,taskId:'M0',evaluatedCommit,benchmarkVersion:'T0-m0-v1',environmentDigest:artifactHashes['environment.json'],checks,artifactHashes});writeReportExclusive(`${dir}/report.json`,report);console.log(`Evidence: ${dir}/report.json`);process.exitCode=report.passed?0:1;
