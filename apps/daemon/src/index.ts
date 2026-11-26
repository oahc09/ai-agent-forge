#!/usr/bin/env node
import {openLocalRuntime} from '../../cli/src/local-runtime.ts';
import {runFake} from './runtime.ts';
const path=process.argv[2];if(!path)throw new Error('Usage: daemon <private-state-directory> [--once]');
const {store,scheduler}=openLocalRuntime(path);const abort=new AbortController();
process.on('SIGTERM',()=>abort.abort());process.on('SIGINT',()=>abort.abort());
try{
 do{
  scheduler.recoverExpired();const lease=scheduler.claim();
  if(lease)await runFake(scheduler,lease,'success',abort.signal);
  if(process.argv.includes('--once'))break;
  if(!abort.signal.aborted)await new Promise<void>(resolve=>{const timer=setTimeout(resolve,1000);abort.signal.addEventListener('abort',()=>{clearTimeout(timer);resolve();},{once:true});});
 }while(!abort.signal.aborted);
}finally{store.close();}
