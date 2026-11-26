import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { EventStore } from '../../packages/event-store/src/index.ts';
import { makeTask } from '../../packages/domain/src/index.ts';
describe('store real transactional failures',()=>{
 for(const point of ['after-event','after-projection'] as const)it(`rolls back thrown failure ${point}`,()=>{const dir=mkdtempSync(join(tmpdir(),'forge-fault-'));const path=join(dir,'db');try{const s=new EventStore(path,{fault:p=>{if(p===point)throw Error('injected');}});expect(()=>s.createTask(makeTask({id:'t',title:'T',repo:'r'}),'create')).toThrow('injected');expect(s.events()).toEqual([]);expect(s.listTasks()).toEqual([]);s.close();const recovered=new EventStore(path);expect(recovered.replay()).toEqual([]);recovered.close();}finally{rmSync(dir,{recursive:true,force:true});}});
 for(const point of ['after-event','after-projection'] as const)it(`SIGKILL inside transaction ${point} leaves no half commit`,()=>{
  const dir=mkdtempSync(join(tmpdir(),'forge-kill-'));const path=join(dir,'db');
  try{let s=new EventStore(path);s.createTask(makeTask({id:'stable',title:'Committed',repo:'r'}),'stable');s.close();
   const script=`import {EventStore} from ${JSON.stringify(resolve('packages/event-store/src/index.ts'))}; import {makeTask} from ${JSON.stringify(resolve('packages/domain/src/index.ts'))}; const s=new EventStore(${JSON.stringify(path)},{fault:p=>{if(p===${JSON.stringify(point)})process.kill(process.pid,'SIGKILL')}});s.createTask(makeTask({id:'interrupted',title:'Kill',repo:'r'}),'interrupted');`;
   const result=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8'});expect(result.signal,result.stderr).toBe('SIGKILL');
   s=new EventStore(path);expect(s.events()).toHaveLength(1);expect(s.getTask('interrupted')).toBeUndefined();expect(s.replay().map(t=>t.id)).toEqual(['stable']);expect(s.db.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok');s.close();
  }finally{rmSync(dir,{recursive:true,force:true});}
 });
});
