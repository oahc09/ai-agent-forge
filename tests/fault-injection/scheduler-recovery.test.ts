import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { EventStore } from '../../packages/event-store/src/index.ts';
import { makeTask } from '../../packages/domain/src/index.ts';
import { Scheduler } from '../../packages/scheduler/src/index.ts';
import type { Lease } from '../../packages/scheduler/src/index.ts';
const repo='https://github.com/oahc09/ai-agent-forge';
const initial=Date.parse('2026-11-08T10:00:00.000Z');
async function killRunningChild(path:string,taskId:string,now:number):Promise<Lease>{
 const script=`import { EventStore } from ${JSON.stringify(resolve('packages/event-store/src/index.ts'))};
 import { Scheduler } from ${JSON.stringify(resolve('packages/scheduler/src/index.ts'))};
 const now=${now};const store=new EventStore(${JSON.stringify(path)},{clock:()=>new Date(now)});
 const scheduler=new Scheduler(store,{clock:()=>now,leaseMs:100});
 const lease=scheduler.claim(${JSON.stringify(taskId)});if(!lease)throw Error('No lease');scheduler.start(lease);
 process.send({ready:true,lease});setInterval(()=>{},1000);`;
 const child=spawn(process.execPath,['--input-type=module','-e',script],{stdio:['ignore','ignore','pipe','ipc']});
 let stderr='';child.stderr?.on('data',(chunk:Buffer)=>{stderr+=chunk.toString();});
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{
  const lease=await new Promise<Lease>((resolveReady,reject)=>{
   timer=setTimeout(()=>reject(Error(`Child ready timeout: ${stderr}`)),10000);
   child.once('error',reject);
   child.once('exit',(code,signal)=>reject(Error(`Child exited before readiness: ${code}/${signal}: ${stderr}`)));
   child.once('message',(message:unknown)=>{
    const value=message as {ready?:boolean;lease?:Lease};
    if(value.ready===true&&value.lease)resolveReady(value.lease);else reject(Error('Invalid child readiness'));
   });
  });
  if(timer)clearTimeout(timer);
  const exited=once(child,'exit');expect(child.kill('SIGKILL')).toBe(true);
  const [code,signal]=await exited;expect(code).toBeNull();expect(signal).toBe('SIGKILL');return lease;
 }finally{if(timer)clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill('SIGKILL');await exited;}}
}
describe('scheduler process crash acceptance',()=>{
 it('recovers exactly 50 killed RUNNING tasks without loss and fences every stale lease',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'forge-recovery-50-'));const path=join(dir,'runtime.db');let now=initial;let store:EventStore|undefined;
  try{
   store=new EventStore(path,{clock:()=>new Date(now)});let scheduler=new Scheduler(store,{clock:()=>now,leaseMs:100});
   for(let i=0;i<50;i++)scheduler.submit(makeTask({id:`crash-${i}`,title:`Crash fixture ${i}`,repo}),`source-${i}`,'test-operator');
   store.close();store=undefined;
   const killedIds:string[]=[];
   for(let i=0;i<50;i++){
    const id=`crash-${i}`;const stale=await killRunningChild(path,id,now);killedIds.push(id);now+=101;
    store=new EventStore(path,{clock:()=>new Date(now)});scheduler=new Scheduler(store,{clock:()=>now,leaseMs:100});
    expect(store.getTask(id)?.status).toBe('RUNNING');expect(()=>scheduler.evidence(stale,'late-evidence')).toThrow('lease');
    expect(scheduler.recoverExpired()).toBe(1);expect(store.getTask(id)?.status).toBe('QUEUED');
    const renewed=scheduler.claim(id)!;expect(renewed).toBeDefined();expect(renewed.runId).not.toBe(stale.runId);
    expect(()=>scheduler.start(stale)).toThrow('lease');expect(()=>scheduler.heartbeat(stale)).toThrow('lease');
    scheduler.start(renewed);expect(scheduler.finishOffline(renewed).status).toBe('DONE');expect(store.getTask(id)?.attempt).toBe(2);
    store.close();store=undefined;
   }
   expect(killedIds).toHaveLength(50);expect(new Set(killedIds).size).toBe(50);
   store=new EventStore(path,{clock:()=>new Date(now)});const before=store.listTasks();expect(before).toHaveLength(50);expect(before.every(t=>t.status==='DONE')).toBe(true);
   expect(store.events().filter(e=>e.eventType==='task.lease_recovered')).toHaveLength(50);expect(store.replay()).toEqual(before);
   expect(store.db.prepare('SELECT count(*) AS n FROM runtime_calls').get()?.n).toBe(100);
   expect(store.db.prepare('SELECT count(*) AS n FROM runtime_leases').get()?.n).toBe(0);
   expect(store.db.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok');
  }finally{store?.close();rmSync(dir,{recursive:true,force:true});}
 },90000);
 it('completes 100 distinct offline fixtures and replays identical final tasks',()=>{
  const dir=mkdtempSync(join(tmpdir(),'forge-100-'));const path=join(dir,'runtime.db');const store=new EventStore(path,{clock:()=>new Date(initial)});
  try{const scheduler=new Scheduler(store,{clock:()=>initial});for(let i=0;i<100;i++){
   const id=`offline-${i}`;scheduler.submit(makeTask({id,title:`Offline fixture ${i}`,repo}),`source:${id}`,'test-operator');
   const lease=scheduler.claim(id)!;expect(lease).toBeDefined();scheduler.start(lease);expect(scheduler.finishOffline(lease).status).toBe('DONE');
  }
  const before=store.listTasks();expect(before).toHaveLength(100);expect(store.events().filter(e=>e.eventType==='task.finished')).toHaveLength(100);
  expect(store.events()).toHaveLength(1000);expect(store.replay()).toEqual(before);expect(store.events().every(e=>!JSON.stringify(e).includes('leaseToken'))).toBe(true);
  expect(store.db.prepare('SELECT count(*) AS n FROM runtime_calls').get()?.n).toBe(100);
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
 });
});
