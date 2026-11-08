import {fork,type ChildProcess} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import type {Scheduler,Lease} from '../../../packages/scheduler/src/index.ts';
export type FakeMode='success'|'approval'|'failure'|'hang';
export interface FakeResult {taskId:string;pid:number|undefined;outcome:'DONE'|'WAITING_APPROVAL'|'FAILED'|'STOPPED';closed:boolean}
export async function runFake(scheduler:Scheduler,lease:Lease,mode:FakeMode='success',signal?:AbortSignal,timeoutMs=5000):Promise<FakeResult>{
 if(!['success','approval','failure','hang'].includes(mode))throw new Error('Unknown offline fixture');
 scheduler.start(lease);
 const script=fileURLToPath(new URL(import.meta.url.endsWith('.ts')?'./fake-worker.ts':'./fake-worker.js',import.meta.url));
 const child:ChildProcess=fork(script,[mode],{env:{NODE_NO_WARNINGS:'1'},execArgv:[],stdio:['ignore','ignore','ignore','ipc']});
 let approval=false;let invalid=false;let timedOut=false;let stopped=false;
 const stop=()=>{stopped=true;child.kill('SIGTERM');};
 signal?.addEventListener('abort',stop,{once:true});if(signal?.aborted)stop();
 const timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL');},timeoutMs);
 const heartbeat=setInterval(()=>{try{lease=scheduler.heartbeat(lease);}catch{invalid=true;child.kill('SIGKILL');}},Math.min(1000,Math.max(1,Math.floor(scheduler.options.leaseMs/3))));
 child.on('message',(message:unknown)=>{if(message&&typeof message==='object'&&(message as {type?:unknown}).type==='approval'){approval=true;child.kill('SIGTERM');}});
 const code=await new Promise<number|null>((resolve)=>{child.once('error',()=>{invalid=true;});child.once('close',resolve);});
 clearTimeout(timer);clearInterval(heartbeat);signal?.removeEventListener('abort',stop);
 if(invalid||stopped)return {taskId:lease.taskId,pid:child.pid,outcome:'STOPPED',closed:true};
 // Persist approval only after the fixture process has fully exited; no idle model remains.
 if(approval&&!timedOut){scheduler.requestApproval(lease,'Offline fixture requested approval after process exit');return {taskId:lease.taskId,pid:child.pid,outcome:'WAITING_APPROVAL',closed:true};}
 if(code===0&&!timedOut){scheduler.finishOffline(lease);return {taskId:lease.taskId,pid:child.pid,outcome:'DONE',closed:true};}
 scheduler.fail(lease,timedOut?'offline fixture timeout':'offline fixture exit failure');return {taskId:lease.taskId,pid:child.pid,outcome:'FAILED',closed:true};
}
