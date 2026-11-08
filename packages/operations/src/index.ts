import { createHash } from 'node:crypto';
import { EventStore } from '../../event-store/src/index.ts';
import { ContextBroker } from '../../context/src/index.ts';
import type { VerifyEvidence } from '../../context/src/index.ts';
import { validateContextScope, sameScope, validateHandoffCapsule } from '../../execution/src/index.ts';
import type { ContextScope, HandoffCapsule, ContextFact } from '../../execution/src/index.ts';

function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function text(value: unknown): asserts value is string { check(typeof value === 'string' && value.trim().length > 0 && value.length <= 4096 && !/[\u0000-\u001f]/.test(value), 'Invalid text'); }
function integer(value: unknown): asserts value is number { check(Number.isSafeInteger(value) && (value as number) >= 0, 'Invalid nonnegative integer'); }
function hash(value: unknown): string {
 const canonical=(v:unknown):string=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v!==null&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical((v as Record<string,unknown>)[k])).join(',')+'}':JSON.stringify(v);
 return createHash('sha256').update(canonical(value)).digest('hex');
}
function exact(value: unknown, keys: string[]): void { check(value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype && Reflect.ownKeys(value).length === keys.length && keys.every(key => {const descriptor=Object.getOwnPropertyDescriptor(value,key);return descriptor!==undefined && 'value' in descriptor;}), 'Invalid object fields'); }
function day(value: string): void { check(/^\d{4}-\d\d-\d\d$/.test(value) && new Date(value+'T00:00:00.000Z').toISOString().slice(0,10) === value, 'Invalid UTC day'); }
const DAY = 86_400_000;
export const OPERATIONS_PREVIEW = true;
export interface TriggerRule { source: 'issue'|'ci'|'manual'|'schedule'; repo: string; actors: string[]; requiredLabels: string[]; maxCostMicros: number; minimumValue: number }
export interface TriggerMetadata { eventId: string; source: TriggerRule['source']; repo: string; actor: string; labels: string[]; risk: 'low'|'medium'|'high'; estimatedCostMicros: number; value: number }
export interface TriggerDecision { eventId: string; outcome: 'REJECTED'|'OBSERVED'|'ELIGIBLE'; reasons: string[]; executed: false }
/** Privileged host metadata is not extracted from the untrusted body. This router never executes tasks. */
export class TriggerRouter {
 private readonly store:EventStore;
 private readonly mode:'observe'|'auto';
 private readonly rules: TriggerRule[];
 private readonly scope: string;
 constructor(store: EventStore, rules: TriggerRule[], mode: 'observe'|'auto' = 'observe') {
  this.store=store;this.mode=mode;
  check(mode === 'observe' || mode === 'auto', 'Invalid mode'); check(Array.isArray(rules) && rules.length <= 100, 'Invalid rules');
  for (const rule of rules) { exact(rule,['source','repo','actors','requiredLabels','maxCostMicros','minimumValue']); check(['issue','ci','manual','schedule'].includes(rule.source),'Invalid source'); text(rule.repo); integer(rule.maxCostMicros); integer(rule.minimumValue); for(const list of [rule.actors,rule.requiredLabels]) { check(Array.isArray(list) && list.length <= 100,'Invalid allowlist'); list.forEach(text); } }
  this.rules = structuredClone(rules); this.scope = hash({rules:this.rules,mode});
  store.db.exec('CREATE TABLE IF NOT EXISTS preview_triggers(scope TEXT NOT NULL,id TEXT NOT NULL,request_hash TEXT NOT NULL,decision TEXT NOT NULL,PRIMARY KEY(scope,id))');
 }
 route(metadata: TriggerMetadata, untrustedBody: string): TriggerDecision {
  exact(metadata,['eventId','source','repo','actor','labels','risk','estimatedCostMicros','value']);
  [metadata.eventId,metadata.repo,metadata.actor].forEach(text); check(['issue','ci','manual','schedule'].includes(metadata.source),'Invalid source'); check(['low','medium','high'].includes(metadata.risk),'Invalid risk'); integer(metadata.estimatedCostMicros); integer(metadata.value); check(Array.isArray(metadata.labels) && metadata.labels.length <= 100,'Invalid labels'); metadata.labels.forEach(text); check(typeof untrustedBody === 'string' && untrustedBody.length <= 65536,'Invalid body');
  const m = structuredClone(metadata), requestHash=hash({m,untrustedBody});
  return this.store.transaction(()=>{
   const prior=this.store.db.prepare('SELECT request_hash,decision FROM preview_triggers WHERE scope=? AND id=?').get(this.scope,m.eventId);
   if(prior){check(prior.request_hash===requestHash,'Trigger idempotency conflict');return JSON.parse(String(prior.decision)) as TriggerDecision;}
   const matching = this.rules.filter(r=>r.source===m.source && r.repo===m.repo && r.actors.includes(m.actor) && r.requiredLabels.every(label=>m.labels.includes(label)));
   const reasons:string[]=[];
   if(!matching.length) reasons.push('SOURCE_SCOPE_ACTOR_OR_LABEL_NOT_AUTHORIZED');
   if(m.risk!=='low') reasons.push('RISK_REQUIRES_HUMAN');
   if(matching.length && !matching.some(r=>m.estimatedCostMicros<=r.maxCostMicros && m.value>=r.minimumValue)) reasons.push('VALUE_OR_COST_LIMIT');
   const outcome = reasons.length ? 'REJECTED' : this.mode==='observe' ? 'OBSERVED':'ELIGIBLE';
   if(!reasons.length) reasons.push(outcome==='OBSERVED'?'OBSERVE_ONLY':'TRUSTED_HOST_GRANT_STILL_REQUIRED');
   const decision:TriggerDecision={eventId:m.eventId,outcome,reasons,executed:false};
   this.store.db.prepare('INSERT INTO preview_triggers VALUES(?,?,?,?)').run(this.scope,m.eventId,requestHash,JSON.stringify(decision));return structuredClone(decision);
  });
 }
 audit(): TriggerDecision[] { return this.store.db.prepare('SELECT decision FROM preview_triggers WHERE scope=? ORDER BY id').all(this.scope).map(r=>JSON.parse(String(r.decision)) as TriggerDecision); }
}

/** Durable scoped capsule index. The database and evidence verifier belong to the trusted host. */
export class ProjectMemory {
 private readonly store:EventStore;
 private readonly verify:VerifyEvidence;
 private readonly now:()=>number;
 private readonly scope: ContextScope;
 private readonly scopeId: string;
 constructor(store: EventStore, scope: ContextScope, verify: VerifyEvidence, now:()=>number=Date.now) {
  this.store=store;this.verify=verify;this.now=now;
  validateContextScope(scope); check(typeof verify==='function' && typeof now==='function','Trusted verifier/clock required'); this.scope=structuredClone(scope);this.scopeId=hash(this.scope);
  store.db.exec('CREATE TABLE IF NOT EXISTS preview_memory(scope TEXT NOT NULL,id TEXT NOT NULL,capsule TEXT NOT NULL,archived INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(scope,id))');
 }
 add(value: unknown): void {
  const broker=new ContextBroker(this.scope,this.verify,this.now);const capsule=broker.accept(value);
  this.store.transaction(()=>{check(!this.store.db.prepare('SELECT id FROM preview_memory WHERE scope=? AND id=?').get(this.scopeId,capsule.id),'Immutable memory ID');validateHandoffCapsule(capsule,this.now());this.store.db.prepare('INSERT INTO preview_memory(scope,id,capsule) VALUES(?,?,?)').run(this.scopeId,capsule.id,JSON.stringify(capsule));});
 }
 search(query:string,scope:ContextScope,limit=20): {capsuleId:string;fact:ContextFact}[] {
  text(query);validateContextScope(scope);check(sameScope(scope,this.scope),'Scope mismatch');integer(limit);check(limit>0 && limit<=100,'Invalid limit');
  const terms=query.toLocaleLowerCase('en-US').split(/\s+/).filter(Boolean);
  const hits:{capsuleId:string;fact:ContextFact;score:number;expiresAt:number}[]=[];
  for(const row of this.store.db.prepare('SELECT capsule FROM preview_memory WHERE scope=? AND archived=0 ORDER BY id').all(this.scopeId)){
   const capsule=JSON.parse(String(row.capsule)) as HandoffCapsule;
   // Revalidate stored bytes and verified evidence, including expiry during verification.
   try{new ContextBroker(this.scope,this.verify,this.now).accept(capsule);}catch{continue;}
   for(const fact of capsule.facts){const normalized=fact.text.toLocaleLowerCase('en-US');const score=terms.filter(term=>normalized.includes(term)).length;if(score>0)hits.push({capsuleId:capsule.id,fact:structuredClone(fact),score,expiresAt:Date.parse(capsule.expiresAt)});}
  }
  const readAt=this.now();integer(readAt);
  return hits.filter(hit=>hit.expiresAt>readAt && this.store.db.prepare('SELECT archived FROM preview_memory WHERE scope=? AND id=?').get(this.scopeId,hit.capsuleId)?.archived===0).sort((a,b)=>b.score-a.score||a.capsuleId.localeCompare(b.capsuleId)||a.fact.id.localeCompare(b.fact.id)).slice(0,limit).map(({capsuleId,fact})=>({capsuleId,fact}));
 }
 archive(id:string):void {text(id);check(this.store.db.prepare('UPDATE preview_memory SET archived=1 WHERE scope=? AND id=?').run(this.scopeId,id).changes===1,'Unknown memory');}
 expire():number {const now=this.now();integer(now);let count=0;return this.store.transaction(()=>{for(const row of this.store.db.prepare('SELECT id,capsule FROM preview_memory WHERE scope=? AND archived=0').all(this.scopeId)){const c=JSON.parse(String(row.capsule)) as HandoffCapsule;if(Date.parse(c.expiresAt)<=now){this.store.db.prepare('UPDATE preview_memory SET archived=1 WHERE scope=? AND id=?').run(this.scopeId,String(row.id));count++;}}return count;});}
}

export interface PilotTask { id:string; category:string; objective:string; acceptance:string }
export interface PilotProtocol { id:string; startDay:string; days:30; timezone:'UTC'; kind:'fixture'|'host-assisted'; tasks:PilotTask[]; maxCostMicros:number }
export interface PilotOutcome { status:'accepted'|'failed'|'blocked'|'timed_out'; independent:boolean; humanAssisted:boolean; evidenceDigest:string|null; costMicros:number }
export interface PilotSummary { protocolDigest:string; claim:'NOT_VERIFIED'; kind:PilotProtocol['kind']; denominator:number; numerator:number; autonomousRate:number|null; costMicros:number; missingDays:string[]; unresolvedTaskIds:string[]; dailyReports:number; lateTaskIds:string[]; reasons:string[] }
/** Offline trial accounting, NOT a real-provider runner or G8 assessor. No API can assert real execution. */
export class PilotLedger {
 private readonly store:EventStore;
 private readonly now:()=>number;
 private readonly protocol:PilotProtocol;
 readonly protocolDigest:string;
 constructor(store:EventStore, protocol:PilotProtocol, now:()=>number=Date.now){
  this.store=store;this.now=now;
  exact(protocol,['id','startDay','days','timezone','kind','tasks','maxCostMicros']);text(protocol.id);day(protocol.startDay);check(protocol.days===30 && protocol.timezone==='UTC' && ['fixture','host-assisted'].includes(protocol.kind),'Invalid preview protocol');integer(protocol.maxCostMicros);
  check(Array.isArray(protocol.tasks) && protocol.tasks.length>=30 && protocol.tasks.length<=10000,'At least 30 frozen task definitions required');
  const ids=new Set<string>();for(const task of protocol.tasks){exact(task,['id','category','objective','acceptance']);Object.values(task).forEach(text);check(!ids.has(task.id),'Duplicate task');ids.add(task.id);}
  check(typeof now==='function','Clock required');this.protocol=structuredClone(protocol);this.protocolDigest=hash(this.protocol);
  store.db.exec('CREATE TABLE IF NOT EXISTS preview_pilots(id TEXT PRIMARY KEY,digest TEXT NOT NULL,protocol TEXT NOT NULL); CREATE TABLE IF NOT EXISTS preview_pilot_tasks(pilot TEXT NOT NULL,id TEXT NOT NULL,claimed_at INTEGER NOT NULL,reserved INTEGER NOT NULL,outcome TEXT,PRIMARY KEY(pilot,id)); CREATE TABLE IF NOT EXISTS preview_pilot_days(pilot TEXT NOT NULL,day TEXT NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(pilot,day)); CREATE TABLE IF NOT EXISTS preview_pilot_interventions(pilot TEXT NOT NULL,task TEXT NOT NULL,id TEXT NOT NULL,kind TEXT NOT NULL,PRIMARY KEY(pilot,id));');
  store.transaction(()=>{const prior=store.db.prepare('SELECT digest FROM preview_pilots WHERE id=?').get(protocol.id);if(prior)check(prior.digest===this.protocolDigest,'Protocol is frozen');else store.db.prepare('INSERT INTO preview_pilots VALUES(?,?,?)').run(protocol.id,this.protocolDigest,JSON.stringify(this.protocol));});
 }
 private clock():number{const now=this.now();integer(now);return now;}
 private inWindow(now:number):boolean{const start=Date.parse(this.protocol.startDay+'T00:00:00.000Z');return now>=start && now<start+30*DAY;}
 claim(taskId:string,reservedCostMicros:number,admission:{authorized:boolean;dependencyReady:boolean}):boolean{
  text(taskId);integer(reservedCostMicros);exact(admission,['authorized','dependencyReady']);check(admission.authorized===true && admission.dependencyReady===true,'Trusted authorized dependency-ready admission required');check(this.protocol.tasks.some(t=>t.id===taskId),'Task not in frozen pool');const now=this.clock();check(this.inWindow(now),'Outside pilot window');
  return this.store.transaction(()=>{const prior=this.store.db.prepare('SELECT reserved FROM preview_pilot_tasks WHERE pilot=? AND id=?').get(this.protocol.id,taskId);if(prior){check(prior.reserved===reservedCostMicros,'Reservation conflict');return false;}
   const used=Number(this.store.db.prepare('SELECT COALESCE(SUM(reserved),0) AS cost FROM preview_pilot_tasks WHERE pilot=?').get(this.protocol.id)?.cost);check(Number.isSafeInteger(used+reservedCostMicros) && used+reservedCostMicros<=this.protocol.maxCostMicros,'Pilot budget exhausted');
   this.store.db.prepare('INSERT INTO preview_pilot_tasks(pilot,id,claimed_at,reserved) VALUES(?,?,?,?)').run(this.protocol.id,taskId,now,reservedCostMicros);return true;});
 }
 intervention(taskId:string,id:string,kind:'approval'|'guidance'):void{
  text(taskId);text(id);check(kind==='approval'||kind==='guidance','Invalid intervention');
  this.store.transaction(()=>{const task=this.store.db.prepare('SELECT outcome FROM preview_pilot_tasks WHERE pilot=? AND id=?').get(this.protocol.id,taskId);check(task,'Unclaimed task');
   const old=this.store.db.prepare('SELECT task,kind FROM preview_pilot_interventions WHERE pilot=? AND id=?').get(this.protocol.id,id);if(old){check(old.task===taskId && old.kind===kind,'Intervention idempotency conflict');return;}
   check(task.outcome===null,'Outcome already frozen');this.store.db.prepare('INSERT INTO preview_pilot_interventions VALUES(?,?,?,?)').run(this.protocol.id,taskId,id,kind);});
 }
 record(taskId:string,outcome:PilotOutcome):void{
  text(taskId);exact(outcome,['status','independent','humanAssisted','evidenceDigest','costMicros']);check(['accepted','failed','blocked','timed_out'].includes(outcome.status),'Invalid outcome');check(typeof outcome.independent==='boolean' && typeof outcome.humanAssisted==='boolean','Invalid boolean');integer(outcome.costMicros);check(outcome.evidenceDigest===null || typeof outcome.evidenceDigest==='string' && /^[a-f0-9]{64}$/.test(outcome.evidenceDigest),'Invalid evidence digest');check(outcome.status!=='accepted'||outcome.evidenceDigest!==null,'Accepted requires evidence digest');
  this.store.transaction(()=>{const row=this.store.db.prepare('SELECT reserved,outcome,claimed_at FROM preview_pilot_tasks WHERE pilot=? AND id=?').get(this.protocol.id,taskId);check(row,'Unclaimed task');check(outcome.costMicros<=Number(row.reserved),'Outcome exceeds reserved budget');const guidance=this.store.db.prepare("SELECT id FROM preview_pilot_interventions WHERE pilot=? AND task=? AND kind='guidance' LIMIT 1").get(this.protocol.id,taskId);check(!guidance||outcome.humanAssisted,'Guidance must count as human assistance');if(row.outcome!==null){const prior=JSON.parse(String(row.outcome)) as {observation:PilotOutcome};check(hash(prior.observation)===hash(outcome),'Outcome is immutable');return;}const recordedAt=this.clock();check(recordedAt>=Number(row.claimed_at),'Completion predates claim');this.store.db.prepare('UPDATE preview_pilot_tasks SET outcome=? WHERE pilot=? AND id=?').run(JSON.stringify({recordedAt,observation:outcome}),this.protocol.id,taskId);});
 }
 dailyReport(utcDay:string,evidenceDigest:string):void{day(utcDay);check(typeof evidenceDigest==='string' && /^[a-f0-9]{64}$/.test(evidenceDigest),'Invalid evidence digest');const at=Date.parse(utcDay+'T00:00:00.000Z');check(this.inWindow(at) && at<=this.clock(),'Invalid report day');this.store.transaction(()=>{const prior=this.store.db.prepare('SELECT digest FROM preview_pilot_days WHERE pilot=? AND day=?').get(this.protocol.id,utcDay);if(prior){check(prior.digest===evidenceDigest,'Daily report immutable');return;}this.store.db.prepare('INSERT INTO preview_pilot_days VALUES(?,?,?)').run(this.protocol.id,utcDay,evidenceDigest);});}
 summary():PilotSummary{
  const rows=this.store.db.prepare('SELECT id,outcome FROM preview_pilot_tasks WHERE pilot=? ORDER BY id').all(this.protocol.id);let numerator=0,costMicros=0;const unresolvedTaskIds:string[]=[];const lateTaskIds:string[]=[];
  for(const row of rows){if(row.outcome===null){unresolvedTaskIds.push(String(row.id));continue;}const record=JSON.parse(String(row.outcome)) as {recordedAt:number;observation:PilotOutcome};const o=record.observation;costMicros+=o.costMicros;const timely=this.inWindow(record.recordedAt);if(!timely)lateTaskIds.push(String(row.id));if(timely&&o.status==='accepted'&&o.independent&&!o.humanAssisted&&o.evidenceDigest)numerator++;}
  const days=this.store.db.prepare('SELECT day FROM preview_pilot_days WHERE pilot=?').all(this.protocol.id).map(r=>String(r.day));const missingDays:string[]=[];const now=this.clock(), start=Date.parse(this.protocol.startDay+'T00:00:00.000Z');
  // Only fully elapsed UTC days are required, not today's unfinished daily report.
  for(let i=0;i<30 && start+(i+1)*DAY<=now;i++){const date=new Date(start+i*DAY).toISOString().slice(0,10);if(!days.includes(date))missingDays.push(date);}
  const reasons=['PREVIEW_NOT_REAL_PROVIDER_EVIDENCE','ORIGINAL_G2_AND_G8_NOT_PASSED'];if(lateTaskIds.length)reasons.push('LATE_OUTCOMES_EXCLUDED_FROM_NUMERATOR');if(rows.length<30)reasons.push('FEWER_THAN_30_CLAIMED_TASKS');if(missingDays.length)reasons.push('MISSING_DAILY_REPORTS');if(unresolvedTaskIds.length)reasons.push('UNRESOLVED_CLAIMS_RETAINED_IN_DENOMINATOR');if(now<start+30*DAY)reasons.push('WINDOW_INCOMPLETE');
  return {protocolDigest:this.protocolDigest,claim:'NOT_VERIFIED',kind:this.protocol.kind,denominator:rows.length,numerator,autonomousRate:rows.length?numerator/rows.length:null,costMicros,missingDays,unresolvedTaskIds,dailyReports:days.length,lateTaskIds,reasons};
 }
}
