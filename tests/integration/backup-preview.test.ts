import { it,expect } from 'vitest';
import { backup } from 'node:sqlite';
import { mkdtempSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventStore } from '../../packages/event-store/src/index.ts';
import { makeTask } from '../../packages/domain/src/index.ts';
import { TriggerRouter } from '../../packages/operations/src/index.ts';
it('restores a real SQLite consistent backup with event replay and preview audit intact',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'forge-backup-'));const source=new EventStore(join(dir,'original.db'));let restored:EventStore|undefined;
 try{
  for(let i=0;i<10;i++)source.createTask(makeTask({id:`task-${i}`,title:`Backup task ${i}`,repo:'owner/repo'}),`create-${i}`);
  const rule={source:'manual' as const,repo:'owner/repo',actors:['operator'],requiredLabels:[],maxCostMicros:0,minimumValue:0};
  new TriggerRouter(source,[rule]).route({eventId:'backup-trigger',source:'manual',repo:'owner/repo',actor:'operator',labels:[],risk:'low',estimatedCostMicros:0,value:0},'fixture');
  await backup(source.db,join(dir,'snapshot.db'));
  source.createTask(makeTask({id:'post-backup',title:'Not in backup',repo:'owner/repo'}),'post-backup');
  restored=new EventStore(join(dir,'snapshot.db'));
  expect(restored.listTasks()).toHaveLength(10);expect(restored.replay()).toHaveLength(10);
  expect(restored.getTask('post-backup')).toBeUndefined();expect(new TriggerRouter(restored,[rule]).audit()).toHaveLength(1);
  expect(source.listTasks()).toHaveLength(11);
 }finally{restored?.close();source.close();rmSync(dir,{recursive:true});}
});
