#!/usr/bin/env node
import {readFileSync,writeFileSync} from 'node:fs';
import {defaultPolicy,parsePolicy} from '../../../packages/policy/src/index.ts';
import {makeTask} from '../../../packages/domain/src/index.ts';
import {readinessReport} from './readiness.ts';
import {openLocalRuntime} from './local-runtime.ts';
import {runFake,type FakeMode} from '../../daemon/src/runtime.ts';
export async function main(input:string[]):Promise<object>{
 const args=input.filter(arg=>arg!=='--json');
 const stateIndex=args.indexOf('--state-dir');let state='.forge';
 if(stateIndex>=0){const path=args[stateIndex+1];if(!path||path.startsWith('--'))throw new Error('--state-dir requires directory');state=path;args.splice(stateIndex,2);}
 const [command,sub,id]=args;
 if(command==='doctor'&&args.includes('--readiness')){
  if(args.length!==2||sub!=='--readiness')throw new Error('Use doctor --readiness without policy or other arguments');
  return readinessReport();
 }
 // M0 compatibility: init/doctor <policy.json> remain config-only, no model or network.
 if(command==='init'&&sub){writeFileSync(sub,JSON.stringify(defaultPolicy(),null,2)+'\n',{flag:'wx',mode:0o600});return {initialized:sub,observeOnly:true,phase:'M0'};}
 if(command==='doctor'&&sub){const policy=parsePolicy(JSON.parse(readFileSync(sub,'utf8')) as unknown);return {configurationValid:true,policy,runtimeReady:false,missing:['M2 sandbox and real adapters'],gate:'NOT_VERIFIED'};}
 if(command==='init') {const runtime=openLocalRuntime(state,true);runtime.store.close();return {initialized:state,observeOnly:true,execution:'fixed offline fixtures only'};}
 if(!['doctor','status','tasks','approval','adapters'].includes(command??''))throw new Error('Commands: init, doctor, status, tasks, approval, adapters. Use --state-dir <private-dir>.');
 const {store,scheduler,operator}=openLocalRuntime(state);
 try {
  if(command==='doctor')return {databaseIntegrity:store.db.prepare('PRAGMA integrity_check').get(),journal:store.db.prepare('PRAGMA journal_mode').get(),offlineRuntimeReady:true,productionReady:false,realAdapters:'NOT_VERIFIED'};
  if(command==='status')return {tasks:store.listTasks(),...scheduler.stats(),execution:'offline-fixture',providerCostUsd:0};
  if(command==='adapters')return {adapters:[{id:'fixed-offline-fixture',real:false}],productionReady:false};
  if(command==='tasks'){
   if(sub==='list'){const at=args.indexOf('--state');const filter=at<0?undefined:args[at+1];if(at>=0&&!filter)throw new Error('--state requires task status');return {tasks:store.listTasks().filter(t=>!filter||t.status===filter)};}
   if(sub==='add'&&id){const raw=JSON.parse(readFileSync(id,'utf8')) as Parameters<typeof makeTask>[0];const task=makeTask(raw);return {task:scheduler.submit(task,`manual:${task.id}`,operator)};}
   if(!id)throw new Error('Task ID required');
   if(sub==='show')return {task:store.getTask(id)??null};
   if(sub==='why')return scheduler.why(id);
   if(sub==='cancel')return {task:scheduler.cancel(id,operator)};
   if(sub==='retry')return {task:scheduler.retry(id)};
   if(sub==='run'){
    if(args.includes('--dry-run'))return {dryRun:true,task:store.getTask(id)??null,willInvoke:false};
    const fixtureIndex=args.indexOf('--fixture');const fixture=fixtureIndex<0?'success':args[fixtureIndex+1];
    if(!['success','approval','failure','hang'].includes(fixture??''))throw new Error('Invalid offline fixture');
    const lease=scheduler.claim(id);if(!lease)return {started:false,why:scheduler.why(id)};
    return await runFake(scheduler,lease,fixture as FakeMode);
   }
  }
  if(command==='approval'){
   if(sub==='list')return {approvals:scheduler.approvals()};
   if(sub==='decide'&&id){if(args.includes('--approve')===args.includes('--deny'))throw new Error('Choose exactly one of --approve or --deny');return {task:scheduler.decide(id,args.includes('--approve'),operator)};}
  }
  throw new Error('Unsupported command or missing argument');
 }finally{store.close();}
}
try{process.stdout.write(JSON.stringify(await main(process.argv.slice(2)),null,2)+'\n');}
catch(error){process.stderr.write(JSON.stringify({error:error instanceof Error?error.message:'Unknown error'})+'\n');process.exitCode=1;}
