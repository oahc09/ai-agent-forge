import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { applyEvent, check, validateTask, validateEvent } from '../../domain/src/index.ts';
import type { EventType, ForgeEvent, ForgeTask, KernelAuthority } from '../../domain/src/index.ts';
export interface AppendCommand { taskId:string; expectedVersion:number; eventType:EventType; payload:Record<string,unknown>; actor:string; idempotencyKey:string; correlationId?:string; causationId?:string }
export interface StoreOptions { clock?:()=>Date; fault?:(point:'after-event'|'after-projection')=>void }
function canonical(value:unknown):string {
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 if(value!==null&&typeof value==='object')return '{'+Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}';
 return JSON.stringify(value);
}
const digest=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');
interface Row { event_json:string; authority_json:string; request_hash:string; result_json:string; sequence:number }
/** Privileged host storage. Never expose this object, database path or authority arguments to a candidate worker. */
export class EventStore {
 readonly db:DatabaseSync;
 private depth=0;
 private readonly options:StoreOptions;
 constructor(path:string,options:StoreOptions={}) {
  this.options=options;this.db=new DatabaseSync(path);this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;');
  this.transaction(()=>{
   this.db.exec('CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
   const version=this.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()?.version;
   check(version===null||version===1,'INTEGRITY_FAILURE','Unsupported database migration version');
   if(version===null){
    this.db.exec(`CREATE TABLE events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,event_id TEXT NOT NULL UNIQUE,task_id TEXT NOT NULL,aggregate_version INTEGER NOT NULL CHECK(aggregate_version>0),idempotency_key TEXT NOT NULL UNIQUE,event_json TEXT NOT NULL,authority_json TEXT NOT NULL,request_hash TEXT NOT NULL,result_json TEXT NOT NULL,UNIQUE(task_id,aggregate_version));
    CREATE TABLE tasks(id TEXT PRIMARY KEY,version INTEGER NOT NULL,task_json TEXT NOT NULL);
    CREATE TABLE snapshots(task_id TEXT NOT NULL,version INTEGER NOT NULL,task_json TEXT NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(task_id,version));
    CREATE INDEX events_task ON events(task_id,aggregate_version);
    CREATE TRIGGER events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'events are immutable'); END;
    CREATE TRIGGER events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'events are immutable'); END;
    CREATE TRIGGER snapshots_no_update BEFORE UPDATE ON snapshots BEGIN SELECT RAISE(ABORT,'snapshots are immutable'); END;
    CREATE TRIGGER snapshots_no_delete BEFORE DELETE ON snapshots BEGIN SELECT RAISE(ABORT,'snapshots are immutable'); END;`);
    this.db.prepare('INSERT INTO schema_migrations VALUES(1,?)').run(this.now());
   }
  });
 }
 private now():string{return (this.options.clock?.()??new Date()).toISOString();}
 transaction<T>(fn:()=>T):T {
  const level=this.depth++;const savepoint=`nested_${level}`;
  try {this.db.exec(level===0?'BEGIN IMMEDIATE':`SAVEPOINT ${savepoint}`);}catch(e){this.depth--;throw e;}
  try{const result=fn();check(!(result instanceof Promise),'SCHEMA_INVALID','Transactions must be synchronous');this.db.exec(level===0?'COMMIT':`RELEASE ${savepoint}`);return result;}
  catch(error){this.db.exec(level===0?'ROLLBACK':`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);throw error;}
  finally{this.depth--;}
 }
 createTask(task:ForgeTask,commandId:string):ForgeTask {
  validateTask(task);
  return this.append({taskId:task.id,expectedVersion:0,eventType:'task.discovered',payload:{task},actor:'system',idempotencyKey:commandId},{kind:'kernel'});
 }
 append(command:AppendCommand,authority:KernelAuthority):ForgeTask {
  check(authority?.kind==='kernel','UNAUTHORIZED','Kernel authority required');
  check(Number.isSafeInteger(command.expectedVersion)&&command.expectedVersion>=0,'SCHEMA_INVALID','Invalid expected version');
  const hash=digest({command,authority});
  return this.transaction(()=>{
   const prior=this.db.prepare('SELECT * FROM events WHERE idempotency_key=?').get(command.idempotencyKey) as unknown as Row|undefined;
   if(prior){check(prior.request_hash===hash,'IDEMPOTENCY_CONFLICT','Idempotency key was used for a different command');return JSON.parse(prior.result_json) as ForgeTask;}
   const task=this.getTask(command.taskId);check((task?.version??0)===command.expectedVersion,'VERSION_CONFLICT','Stale aggregate version');
   const event:ForgeEvent={schemaVersion:1,eventId:randomUUID(),aggregateId:command.taskId,aggregateVersion:command.expectedVersion+1,eventType:command.eventType,occurredAt:this.now(),idempotencyKey:command.idempotencyKey,correlationId:command.correlationId??command.taskId,actor:command.actor,payload:structuredClone(command.payload),...(command.causationId===undefined?{}:{causationId:command.causationId})};
   const next=applyEvent(task,event,authority);
   if(event.eventType==='task.pr_prepared'){
    const reviewed=this.events(command.taskId).some(e=>e.eventType==='task.review_completed'&&e.payload.passed===true&&e.aggregateVersion>this.lastAttemptBoundary(command.taskId));
    check(reviewed,'UNAUTHORIZED','Independent passing review required');
   }
   this.db.prepare('INSERT INTO events(event_id,task_id,aggregate_version,idempotency_key,event_json,authority_json,request_hash,result_json) VALUES(?,?,?,?,?,?,?,?)').run(event.eventId,event.aggregateId,event.aggregateVersion,event.idempotencyKey,JSON.stringify(event),JSON.stringify(authority),hash,JSON.stringify(next));
   this.options.fault?.('after-event');
   this.db.prepare('INSERT INTO tasks(id,version,task_json) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,task_json=excluded.task_json').run(next.id,next.version,JSON.stringify(next));
   this.options.fault?.('after-projection');return structuredClone(next);
  });
 }
 private lastAttemptBoundary(taskId:string):number {const row=this.db.prepare("SELECT MAX(aggregate_version) AS version FROM events WHERE task_id=? AND json_extract(event_json,'$.eventType') IN ('task.claimed','task.retried')").get(taskId);return Number(row?.version??0);}
 getTask(id:string):ForgeTask|undefined {const row=this.db.prepare('SELECT task_json FROM tasks WHERE id=?').get(id);if(!row)return undefined;const task:unknown=JSON.parse(String(row.task_json));validateTask(task);return task;}
 listTasks():ForgeTask[]{return this.db.prepare('SELECT task_json FROM tasks ORDER BY id').all().map(row=>{const task:unknown=JSON.parse(String(row.task_json));validateTask(task);return task;});}
 events(taskId?:string):ForgeEvent[]{const rows=taskId===undefined?this.db.prepare('SELECT event_json FROM events ORDER BY sequence').all():this.db.prepare('SELECT event_json FROM events WHERE task_id=? ORDER BY aggregate_version').all(taskId);return rows.map(row=>{const event:unknown=JSON.parse(String(row.event_json));validateEvent(event);return event;});}
 snapshot(taskId:string):void {this.transaction(()=>{const task=this.getTask(taskId);check(task,'NOT_FOUND','Task missing');this.db.prepare('INSERT OR IGNORE INTO snapshots VALUES(?,?,?,?)').run(task.id,task.version,JSON.stringify(task),digest(task));});}
 /** Rebuilds projections exclusively from immutable audited events; snapshots are validated checkpoints, never the sole source. */
 replay():ForgeTask[]{return this.transaction(()=>{
  const tasks=new Map<string,ForgeTask>();
  const snapshots=new Map<string,{task:ForgeTask;digest:string}>();
  for(const row of this.db.prepare('SELECT * FROM snapshots').all()){const task=JSON.parse(String(row.task_json)) as ForgeTask;validateTask(task);check(digest(task)===row.digest&&task.id===row.task_id&&task.version===row.version,'INTEGRITY_FAILURE','Snapshot corruption');snapshots.set(`${task.id}:${task.version}`,{task,digest:String(row.digest)});}
  for(const row of this.db.prepare('SELECT * FROM events ORDER BY sequence').all()){
   const event=JSON.parse(String(row.event_json)) as ForgeEvent;const authority=JSON.parse(String(row.authority_json)) as KernelAuthority;
   check(event.eventId===row.event_id&&event.aggregateId===row.task_id&&event.aggregateVersion===row.aggregate_version&&event.idempotencyKey===row.idempotency_key,'INTEGRITY_FAILURE','Event index mismatch');
   const next=applyEvent(tasks.get(event.aggregateId),event,authority);
   check(canonical(next)===canonical(JSON.parse(String(row.result_json))),'INTEGRITY_FAILURE','Event result mismatch');
   const snapshot=snapshots.get(`${next.id}:${next.version}`);if(snapshot){check(digest(next)===snapshot.digest,'INTEGRITY_FAILURE','Snapshot does not match events');snapshots.delete(`${next.id}:${next.version}`);}
   tasks.set(next.id,next);
  }
  check(snapshots.size===0,'INTEGRITY_FAILURE','Orphan snapshot');
  this.db.exec('DELETE FROM tasks');const insert=this.db.prepare('INSERT INTO tasks VALUES(?,?,?)');for(const task of tasks.values())insert.run(task.id,task.version,JSON.stringify(task));return this.listTasks();
 });}
 close():void{this.db.close();}
}
