import {spawnSync,execFileSync} from 'node:child_process';
import {mkdirSync,writeFileSync,readFileSync,copyFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {createReport,sha256,writeReportExclusive} from '../packages/observability/src/index.ts';
const milestone=process.argv[2]??'M2';if(!['M0','M1','M2'].includes(milestone))throw new Error('Supported verification milestones: M0, M1, M2 (offline tasks only)');
const runId=randomUUID(); const dir=`artifacts/${milestone}/${runId}`; mkdirSync(dir,{recursive:true});
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
save('policy.json',{scope:`${milestone} offline implementation verification only`,remoteActions:[],modelCalls:0,merged:false,deployed:false,authority:'User requested development and submission to oahc09/ai-agent-forge; active product grants remain disabled'});
save('cost.json',{modelCalls:0,providerChargesUsd:0,source:'Verification scripts invoke no model provider; assistant development service costs are not measured here'});
save('plan.md',`Verify ${milestone}: lint, strict types, full offline unit/security/CLI/fault-injection suite and build. No real-provider or product autonomy claim.\n`);
save('review.md','Independent review is required for completion. See docs/m2-independent-review.md, docs/m1-independent-review.md and docs/m0-independent-review.md. This generated report does not impersonate a reviewer or approve later Gates.\n');
save('report.md',`# ${milestone} offline verification\n\nCommit: ${evaluatedCommit}\nDirty: ${environment.dirty}\nAutomated checks: ${checks.every(c=>c.passed)?'PASS':'FAIL'}\nHuman G0 baseline review: approved by user\nG1: independently reviewed and CI passed\nG2–G8: NOT_VERIFIED\nReproduce: pnpm install --frozen-lockfile && pnpm verify\n`);
const tasks=JSON.parse(readFileSync('backlog.json','utf8')).tasks.filter(t=>t.milestone===milestone&&(milestone!=='M2'||['M2-01','M2-05'].includes(t.id)));
for(const task of tasks){
 const taskDir=`artifacts/${task.id}/${runId}`;mkdirSync(taskDir,{recursive:true});
 const hashes={...artifactHashes}; for(const name of Object.keys(hashes))copyFileSync(`${dir}/${name}`,`${taskDir}/${name}`);
 const taskBytes=JSON.stringify({...task,status:'NOT_VERIFIED',automatedChecks:checks.every(c=>c.passed)?'PASS':'FAIL',remaining:['Independent review for this exact commit']},null,2)+'\n';writeFileSync(`${taskDir}/task.json`,taskBytes);hashes['task.json']=sha256(taskBytes);
 writeReportExclusive(`${taskDir}/report.json`,createReport({runId,taskId:task.id,evaluatedCommit,benchmarkVersion:`T0-T1-${milestone.toLowerCase()}-v1`,environmentDigest:artifactHashes['environment.json'],checks,artifactHashes:hashes}));
}
save('task.json',{taskId:milestone,scope:tasks.map(t=>t.id),status:'NOT_VERIFIED'});
const report=createReport({runId,taskId:milestone,evaluatedCommit,benchmarkVersion:`T0-T1-${milestone.toLowerCase()}-v1`,environmentDigest:artifactHashes['environment.json'],checks,artifactHashes});writeReportExclusive(`${dir}/report.json`,report);console.log(`Evidence: ${dir}/report.json`);process.exitCode=report.passed?0:1;
