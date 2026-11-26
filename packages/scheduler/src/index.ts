import {randomUUID,timingSafeEqual} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type {ForgeTask,EventType,KernelAuthority} from '../../domain/src/index.ts';
import {EventStore} from '../../event-store/src/index.ts';
import {defaultPolicy,parsePolicy} from '../../policy/src/index.ts';
import {issueOfflineGrant} from '../../policy/src/offline-grant.ts';
export interface SchedulerOptions {
 clock?:()=>number; leaseMs?:number; concurrency?:number; maxCallsTotal?:number;
 maxCallsDay?:number; maxCallsTask?:number; retryBaseMs?:number; policy?:unknown;
}
export interface Lease {taskId:string;runId:string;token:string;until:number}
interface LeaseRow {task_id:string;run_id:string;token:string;until_ms:number}
interface GrantRow {id:string;task_id:string;repo:string;actor:string;expires_at:number;revoked:number}
export interface Approval {id:string;task_id:string;grant_id:string;state:string;reason:string;requested_at:number;decided_by:string|null}
/** Deterministic, privileged single-node kernel. No arbitrary commands or external models. */
export class Scheduler {
 readonly clock:()=>number;
 readonly options:Required<Omit<SchedulerOptions,'clock'|'policy'>>;
 readonly policy:ReturnType<typeof parsePolicy>;
 readonly store:EventStore;
 constructor(store:EventStore,options:SchedulerOptions={}){
  this.store=store;
  this.clock=options.clock??Date.now;
  this.policy=parsePolicy(options.policy??defaultPolicy());
  this.options={leaseMs:options.leaseMs??30_000,concurrency:options.concurrency??1,maxCallsTotal:options.maxCallsTotal??1000,maxCallsDay:options.maxCallsDay??1000,maxCallsTask:options.maxCallsTask??3,retryBaseMs:options.retryBaseMs??1000};
  for(const [key,value] of Object.entries(this.options))if(!Number.isSafeInteger(value)||value<0)throw new Error(`Invalid scheduler limit ${key}`);
  if(this.options.leaseMs<1||this.options.concurrency<1||this.options.concurrency>this.policy.maxConcurrentWorkers)throw new Error('Invalid concurrency or lease');
  store.db.exec(`CREATE TABLE IF NOT EXISTS runtime_grants(id TEXT PRIMARY KEY, task_id TEXT UNIQUE NOT NULL, repo TEXT NOT NULL, actor TEXT NOT NULL, expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS runtime_leases(task_id TEXT PRIMARY KEY,run_id TEXT UNIQUE NOT NULL,token TEXT NOT NULL,until_ms INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS runtime_approvals(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,grant_id TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('PENDING','APPROVED','DENIED')),reason TEXT NOT NULL,requested_at INTEGER NOT NULL,decided_by TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS one_pending_approval ON runtime_approvals(task_id) WHERE state='PENDING';
CREATE TABLE IF NOT EXISTS runtime_calls(run_id TEXT PRIMARY KEY,task_id TEXT NOT NULL,day TEXT NOT NULL,cost_microusd INTEGER NOT NULL DEFAULT 0 CHECK(cost_microusd=0));
CREATE TABLE IF NOT EXISTS runtime_retry(task_id TEXT PRIMARY KEY,ready_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS runtime_effects(effect_key TEXT PRIMARY KEY,task_id TEXT NOT NULL,run_id TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('PENDING','CONFIRMED','UNKNOWN')),evidence TEXT);
CREATE TABLE IF NOT EXISTS runtime_decisions(id INTEGER PRIMARY KEY AUTOINCREMENT,task_id TEXT,at INTEGER NOT NULL,reason TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS runtime_config(id INTEGER PRIMARY KEY CHECK(id=1),options_json TEXT NOT NULL,policy_json TEXT NOT NULL);`);
  store.db.prepare('INSERT OR IGNORE INTO runtime_config VALUES(1,?,?)').run(JSON.stringify(this.options),JSON.stringify(this.policy));
  const persisted=store.db.prepare('SELECT * FROM runtime_config WHERE id=1').get() as {options_json:string;policy_json:string};
  if(!isDeepStrictEqual(JSON.parse(persisted.policy_json),this.policy))throw new Error('Runtime policy change requires separate approval');
  const saved=JSON.parse(persisted.options_json) as typeof this.options;
  for(const key of Object.keys(saved) as (keyof typeof this.options)[])if(options[key]!==undefined&&options[key]!==saved[key])throw new Error('Persisted runtime budget/limits cannot be silently changed');
  this.options=saved;
 }
 private now():number {const now=this.clock();if(!Number.isSafeInteger(now)||now<0)throw new Error('Invalid clock');return now;}
 private decision(taskId:string|null,reason:string):void {this.store.db.prepare('INSERT INTO runtime_decisions(task_id,at,reason) VALUES(?,?,?)').run(taskId,this.now(),reason);}
 private task(id:string):ForgeTask {const task=this.store.getTask(id);if(!task)throw new Error('Task not found');return task;}
 private grant(task:ForgeTask):GrantRow {const row=this.store.db.prepare('SELECT * FROM runtime_grants WHERE task_id=?').get(task.id) as unknown as GrantRow|undefined;if(!row||row.revoked||row.repo!==task.repo||row.expires_at<=this.now())throw new Error('No valid policy grant');return row;}
 private event(task:ForgeTask,type:EventType,payload:Record<string,unknown>,authority:Partial<KernelAuthority>={},key=randomUUID()):ForgeTask {
  return this.store.append({taskId:task.id,expectedVersion:task.version,eventType:type,payload,actor:'system:offline-kernel',idempotencyKey:key},{kind:'kernel',...authority});
 }
 /** The trusted host creates a known offline fixture; untrusted Issue text cannot call this. */
 submit(task:ForgeTask,commandId:string,operator:string):ForgeTask {
  return this.store.transaction(()=>{
   if(!operator)throw new Error('Authenticated local operator required');
   const existing=this.store.getTask(task.id);
   if(existing){const first=this.store.events(task.id)[0];if(first?.idempotencyKey!==commandId||!isDeepStrictEqual(first.payload.task,task))throw new Error('Task ID/idempotency payload collision');return existing;}
   if(task.dependencies.some(id=>id===task.id||!this.store.getTask(id)))throw new Error('Unknown/self dependency');
   if(task.risk!=='low'||task.maxAttempts>this.policy.maxAttempts)throw new Error('Only bounded low-risk offline fixtures are allowed');
   if(task.permissions.length!==0)throw new Error('Task payload cannot grant permissions');
   const grant=issueOfflineGrant(this.policy,{taskId:task.id,repo:task.repo,actor:operator,now:this.now()});
   let current=this.store.createTask(task,commandId);
   current=this.event(current,'task.triaged',{});
   this.store.db.prepare('INSERT INTO runtime_grants(id,task_id,repo,actor,expires_at) VALUES(?,?,?,?,?)').run(grant.id,grant.taskId,grant.repo,grant.actor,grant.expiresAt);
   current=this.event(current,'auth.granted',{}, {policyDecisionId:grant.id,permissions:grant.permissions});
   this.decision(task.id,'Offline fixture explicitly submitted by local operator; fake.run only');
   return current;
  });
 }
 claim(taskId?:string):Lease|undefined {
  return this.store.transaction(()=>{
   const now=this.now();
   const active=Number((this.store.db.prepare('SELECT COUNT(*) AS n FROM runtime_leases').get() as {n:number}).n);
   if(active>=this.options.concurrency){this.decision(taskId??null,'concurrency limit; reconcile expired leases first');return;}
   for(const task of this.store.listTasks().filter(t=>(!taskId||t.id===taskId)&&t.status==='QUEUED')){
    let grant:GrantRow;try{grant=this.grant(task);}catch{this.decision(task.id,'expired or absent policy grant');continue;}
    if(task.dependencies.some(id=>this.store.getTask(id)?.status!=='DONE')){this.decision(task.id,'dependency not DONE');continue;}
    const retry=this.store.db.prepare('SELECT ready_at FROM runtime_retry WHERE task_id=?').get(task.id) as {ready_at:number}|undefined;
    if(retry&&retry.ready_at>now){this.decision(task.id,'retry backoff');continue;}
    if(task.attempt>=task.maxAttempts){this.event(task,'task.quarantined',{reason:'attempt limit'});continue;}
    const day=new Date(now).toISOString().slice(0,10);
    const counts=this.store.db.prepare('SELECT COUNT(*) total,SUM(day=?) daily,SUM(task_id=?) task FROM runtime_calls').get(day,task.id) as {total:number;daily:number|null;task:number|null};
    if(counts.total>=this.options.maxCallsTotal||(counts.daily??0)>=this.options.maxCallsDay||(counts.task??0)>=this.options.maxCallsTask){this.decision(task.id,'budget exhausted; no new invocation');continue;}
    const lease:Lease={taskId:task.id,runId:randomUUID(),token:randomUUID(),until:now+this.options.leaseMs};
    this.store.db.prepare('INSERT INTO runtime_leases VALUES(?,?,?,?)').run(task.id,lease.runId,lease.token,lease.until);
    this.store.db.prepare('INSERT INTO runtime_calls(run_id,task_id,day) VALUES(?,?,?)').run(lease.runId,task.id,day);
    this.event(task,'task.claimed',{}, {policyDecisionId:grant.id,permissions:['fake.run'],dependenciesSatisfied:true,lease:{runId:lease.runId,leaseUntil:new Date(lease.until).toISOString()}});
    this.decision(task.id,`claimed ${lease.runId}; offline call reserved atomically`);return lease;
   }
   return;
  });
 }
 private check(lease:Lease):ForgeTask {
  const row=this.store.db.prepare('SELECT * FROM runtime_leases WHERE task_id=?').get(lease.taskId) as unknown as LeaseRow|undefined;
  const equal=row&&Buffer.byteLength(row.token)===Buffer.byteLength(lease.token)&&timingSafeEqual(Buffer.from(row.token),Buffer.from(lease.token));
  if(!row||row.run_id!==lease.runId||!equal||row.until_ms<=this.now())throw new Error('Stale, expired or forged worker lease');
  const task=this.task(lease.taskId);this.grant(task);return task;
 }
 start(lease:Lease):ForgeTask {return this.store.transaction(()=>this.event(this.check(lease),'task.started',{}, {lease:{runId:lease.runId,leaseUntil:new Date(lease.until).toISOString()}}));}
 heartbeat(lease:Lease):Lease {return this.store.transaction(()=>{const task=this.check(lease);const until=this.now()+this.options.leaseMs;this.store.db.prepare('UPDATE runtime_leases SET until_ms=? WHERE task_id=?').run(until,task.id);this.event(task,'task.heartbeat',{}, {lease:{runId:lease.runId,leaseUntil:new Date(until).toISOString()}});return {...lease,until};});}
 evidence(lease:Lease,evidenceRef:string):void {this.store.transaction(()=>{if(!/^[a-zA-Z0-9_./-]{1,200}$/.test(evidenceRef))throw new Error('Invalid evidence reference');this.event(this.check(lease),'task.evidence_recorded',{evidenceRef},{lease:{runId:lease.runId,leaseUntil:new Date(lease.until).toISOString()}});});}
 finishOffline(lease:Lease):ForgeTask {return this.store.transaction(()=>{
  let task=this.check(lease);const authority={lease:{runId:lease.runId,leaseUntil:new Date(lease.until).toISOString()}};
  task=this.event(task,'task.validation_started',{},authority);
  task=this.event(task,'task.validation_completed',{passed:true,reportId:'offline-fixture-validation'},authority);
  task=this.event(task,'task.review_completed',{passed:true,reportId:'offline-fixture-review'},authority);
  task=this.event(task,'task.pr_prepared',{deliveryRef:'offline-fixture'},authority);
  task=this.event(task,'task.finished',{deliveryType:'local_only'},authority);
  this.store.db.prepare('DELETE FROM runtime_leases WHERE task_id=?').run(task.id);return task;
 });}
 fail(lease:Lease,reason:string):void {this.store.transaction(()=>{const task=this.check(lease);this.event(task,'task.failed',{reason},{lease:{runId:lease.runId,leaseUntil:new Date(lease.until).toISOString()}});this.store.db.prepare('DELETE FROM runtime_leases WHERE task_id=?').run(task.id);this.decision(task.id,'worker failed; explicit bounded retry required');});}
 retry(taskId:string):ForgeTask {return this.store.transaction(()=>{const task=this.task(taskId);const grant=this.grant(task);if(this.hasEffects(taskId))throw new Error('Side effects require reconciliation before retry');if(task.attempt>=Math.min(task.maxAttempts,this.policy.maxAttempts))throw new Error('Circuit breaker: max attempts');const next=this.event(task,'task.retried',{}, {policyDecisionId:grant.id,permissions:['fake.run'],sideEffectsReconciled:!this.hasEffects(taskId)});this.store.db.prepare('INSERT OR REPLACE INTO runtime_retry VALUES(?,?)').run(taskId,this.now()+this.options.retryBaseMs*2**Math.max(0,task.attempt-1));return next;});}
 requestApproval(lease:Lease,reason:string):Approval {return this.store.transaction(()=>{
  const task=this.check(lease);const grant=this.grant(task);if(!reason.trim()||reason.length>500)throw new Error('Invalid approval reason');
  const id=randomUUID();this.store.db.prepare("INSERT INTO runtime_approvals VALUES(?,?,?,'PENDING',?,?,NULL)").run(id,task.id,grant.id,reason,this.now());
  this.event(task,'task.awaiting_approval',{approvalId:id,reason},{approvalId:id,lease:{runId:lease.runId,leaseUntil:new Date(lease.until).toISOString()}});
  this.store.db.prepare('DELETE FROM runtime_leases WHERE task_id=?').run(task.id);return this.approvals().find(a=>a.id===id)!;
 });}
 approvals():Approval[]{return this.store.db.prepare('SELECT * FROM runtime_approvals ORDER BY requested_at,id').all() as unknown as Approval[];}
 decide(id:string,approve:boolean,operator:string):ForgeTask {return this.store.transaction(()=>{
  if(!operator||typeof approve!=='boolean')throw new Error('Authenticated local operator required');
  const card=this.store.db.prepare('SELECT * FROM runtime_approvals WHERE id=?').get(id) as unknown as Approval|undefined;
  if(!card||card.state!=='PENDING')throw new Error('Approval missing or already decided');
  const task=this.task(card.task_id);
  const grant=approve?this.grant(task):this.store.db.prepare('SELECT * FROM runtime_grants WHERE task_id=?').get(task.id) as unknown as GrantRow|undefined;
  if(!grant||grant.id!==card.grant_id||grant.repo!==task.repo)throw new Error('Approval scope no longer valid');
  this.store.db.prepare('UPDATE runtime_approvals SET state=?,decided_by=? WHERE id=?').run(approve?'APPROVED':'DENIED',operator,id);
  if(!approve)this.store.db.prepare('UPDATE runtime_grants SET revoked=1 WHERE task_id=?').run(task.id);
  return this.event(task,approve?'task.resumed':'auth.denied',approve?{approvalId:id,reason:`Approved by ${operator}`}:{reason:`Denied by ${operator}`},{approvalId:id,policyDecisionId:grant.id,permissions:['fake.run']});
 });}
 cancel(id:string,operator:string):ForgeTask {return this.store.transaction(()=>{if(!operator)throw new Error('Authenticated operator required');const task=this.event(this.task(id),'task.cancelled',{reason:`Cancelled by ${operator}`});this.store.db.prepare('DELETE FROM runtime_leases WHERE task_id=?').run(id);this.store.db.prepare('UPDATE runtime_grants SET revoked=1 WHERE task_id=?').run(id);this.store.db.prepare("UPDATE runtime_approvals SET state='DENIED',decided_by=? WHERE task_id=? AND state='PENDING'").run(operator,id);return task;});}
 /** Side-effect ledger is reconciliation evidence only; M1 performs no external effects. */
 recordEffect(lease:Lease,key:string,state:'PENDING'|'CONFIRMED'|'UNKNOWN',evidence:string):void {this.store.transaction(()=>{this.check(lease);if(!key||!evidence)throw new Error('Evidence and idempotency key required');this.store.db.prepare('INSERT INTO runtime_effects VALUES(?,?,?,?,?)').run(key,lease.taskId,lease.runId,state,evidence);});}
 private hasEffects(taskId:string):boolean {return !!this.store.db.prepare('SELECT effect_key FROM runtime_effects WHERE task_id=? LIMIT 1').get(taskId);}
 recoverExpired():number {return this.store.transaction(()=>{
  const rows=this.store.db.prepare('SELECT * FROM runtime_leases WHERE until_ms<=?').all(this.now()) as unknown as LeaseRow[];
  for(const row of rows){const task=this.task(row.task_id);const effects=this.hasEffects(task.id);
   if(effects||task.attempt>=task.maxAttempts)this.event(task,'task.quarantined',{reason:effects?'side effects require human reconciliation':'attempt limit after crash'});
   else this.event(task,'task.lease_recovered',{}, {sideEffectsReconciled:true});
   this.store.db.prepare('DELETE FROM runtime_leases WHERE task_id=?').run(task.id);this.decision(task.id,effects?'quarantined: cannot prove retry safe':'expired lease reconciled: no external effects');
  }
  return rows.length;
 });}
 why(id:string):object {return {task:this.task(id),events:this.store.events(id),decisions:this.store.db.prepare('SELECT at,reason FROM runtime_decisions WHERE task_id=? ORDER BY id').all(id)};}
 stats():object{return {calls:this.store.db.prepare('SELECT COUNT(*) total,COALESCE(SUM(cost_microusd),0) costMicroUsd FROM runtime_calls').get(),leases:this.store.db.prepare('SELECT task_id,run_id,until_ms FROM runtime_leases').all(),pendingApprovals:this.approvals().filter(a=>a.state==='PENDING').length};}
}
