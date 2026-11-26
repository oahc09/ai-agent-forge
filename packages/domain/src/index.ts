/** The in-process kernel is trusted. Worker input must never be cast to KernelAuthority. */
export const TASK_STATUSES = ['DISCOVERED','TRIAGED','AWAITING_AUTH','QUEUED','CLAIMED','RUNNING','WAITING_APPROVAL','VALIDATING','REVIEWING','PR_READY','DONE','FAILED','CANCELLED','QUARANTINED'] as const;
export type TaskStatus = typeof TASK_STATUSES[number];
export const EVENT_TYPES = ['task.discovered','task.triaged','auth.requested','auth.granted','auth.denied','task.queued','task.claimed','task.started','task.heartbeat','task.awaiting_approval','task.resumed','task.validation_started','task.validation_completed','task.review_completed','task.pr_prepared','task.finished','task.failed','task.retried','task.cancelled','task.quarantined','task.evidence_recorded','task.lease_recovered','budget.exhausted','policy.violation'] as const;
export type EventType = typeof EVENT_TYPES[number];
export interface ForgeTask {
  id:string; title:string; repo:string; source:{kind:'issue'|'ci'|'schedule'|'manual';ref:string}; status:TaskStatus;
  risk:'low'|'medium'|'high'; permissions:string[]; dependencies:string[]; allowedPaths:string[]; acceptanceIds:string[];
  attempt:number; maxAttempts:number; budgetId:string; runId?:string; leaseUntil?:string; version:number;
}
export interface ForgeEvent<T = Record<string,unknown>> {
  schemaVersion:1; eventId:string; aggregateId:string; aggregateVersion:number; eventType:EventType;
  occurredAt:string; idempotencyKey:string; correlationId:string; causationId?:string; actor:string; payload:T;
}
export interface KernelAuthority {
  kind:'kernel'; policyDecisionId?:string; permissions?:string[]; lease?:{runId:string;leaseUntil:string};
  approvalId?:string; dependenciesSatisfied?:boolean; sideEffectsReconciled?:boolean;
}
export type ErrorCode = 'SCHEMA_INVALID'|'UNAUTHORIZED'|'INVALID_TRANSITION'|'VERSION_CONFLICT'|'IDEMPOTENCY_CONFLICT'|'NOT_FOUND'|'INTEGRITY_FAILURE';
export class DomainError extends Error { readonly code:ErrorCode; constructor(code:ErrorCode,message:string) {super(message);this.code=code;this.name='DomainError';} }
export function check(condition:unknown,code:ErrorCode,message:string):asserts condition {if(!condition)throw new DomainError(code,message);}
const text=(v:unknown):v is string=>typeof v==='string'&&v.trim().length>0;
const strings=(v:unknown):v is string[]=>Array.isArray(v)&&v.every(text)&&new Set(v).size===v.length;
export function record(v:unknown):v is Record<string,unknown>{return typeof v==='object'&&v!==null&&!Array.isArray(v)&&Object.getPrototypeOf(v)===Object.prototype;}
export function iso(v:unknown):v is string{return typeof v==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;}
export function validateTask(value:unknown):asserts value is ForgeTask {
 check(record(value),'SCHEMA_INVALID','Task must be an object');
 const allowed=['id','title','repo','source','status','risk','permissions','dependencies','allowedPaths','acceptanceIds','attempt','maxAttempts','budgetId','runId','leaseUntil','version'];
 check(Object.keys(value).every(k=>allowed.includes(k)),'SCHEMA_INVALID','Unknown task field');
 for(const k of ['id','title','repo','budgetId'])check(text(value[k]),'SCHEMA_INVALID',`Invalid task ${k}`);
 check(record(value.source)&&Object.keys(value.source).every(k=>['kind','ref'].includes(k))&&['issue','ci','schedule','manual'].includes(String(value.source.kind))&&text(value.source.ref),'SCHEMA_INVALID','Invalid source');
 check(TASK_STATUSES.includes(value.status as TaskStatus)&&['low','medium','high'].includes(String(value.risk)),'SCHEMA_INVALID','Invalid status/risk');
 for(const k of ['permissions','dependencies','allowedPaths','acceptanceIds'])check(strings(value[k]),'SCHEMA_INVALID',`Invalid ${k}`);
 check(!(value.dependencies as string[]).includes(value.id as string),'SCHEMA_INVALID','Self dependency');
 for(const k of ['attempt','maxAttempts','version'])check(Number.isSafeInteger(value[k])&&(value[k] as number)>=0,'SCHEMA_INVALID',`Invalid ${k}`);
 check((value.maxAttempts as number)>0&&(value.attempt as number)<=(value.maxAttempts as number),'SCHEMA_INVALID','Invalid attempt bound');
 check(value.runId===undefined||text(value.runId),'SCHEMA_INVALID','Invalid runId');
 check(value.leaseUntil===undefined||iso(value.leaseUntil),'SCHEMA_INVALID','Invalid leaseUntil');
}
export function makeTask(input:Pick<ForgeTask,'id'|'title'|'repo'>&Partial<ForgeTask>):ForgeTask {
 const task:ForgeTask={source:{kind:'manual',ref:input.id},status:'DISCOVERED',risk:'low',permissions:[],dependencies:[],allowedPaths:[],acceptanceIds:[],attempt:0,maxAttempts:3,budgetId:'offline',version:0,...input};validateTask(task);return structuredClone(task);
}
const payloadFields:Record<EventType,readonly string[]>={
 'task.discovered':['task'],'task.triaged':['reason'],'auth.requested':['reason'],'auth.granted':['reason'],'auth.denied':['reason'],
 'task.queued':['reason'],'task.claimed':['reason'],'task.started':['reason'],'task.heartbeat':['reason'],
 'task.awaiting_approval':['approvalId','reason'],'task.resumed':['approvalId','reason'],
 'task.validation_started':['reason'],'task.validation_completed':['reportId','passed','reason'],'task.review_completed':['reportId','passed','reason'],
 'task.pr_prepared':['deliveryRef','reason'],'task.finished':['deliveryType','deliveryRef','reason'],'task.failed':['reason','errorCode'],
 'task.retried':['reason'],'task.cancelled':['reason'],'task.quarantined':['reason'],'task.evidence_recorded':['evidenceRef','reason'],
 'task.lease_recovered':['reason'],'budget.exhausted':['reason'],'policy.violation':['reason']};
export function validateEvent(value:unknown):asserts value is ForgeEvent {
 check(record(value),'SCHEMA_INVALID','Event must be an object');
 check(Object.keys(value).every(k=>['schemaVersion','eventId','aggregateId','aggregateVersion','eventType','occurredAt','idempotencyKey','correlationId','causationId','actor','payload'].includes(k)),'SCHEMA_INVALID','Unknown event field');
 check(value.schemaVersion===1&&EVENT_TYPES.includes(value.eventType as EventType),'SCHEMA_INVALID','Unknown schema/event type');
 for(const k of ['eventId','aggregateId','idempotencyKey','correlationId','actor'])check(text(value[k]),'SCHEMA_INVALID',`Invalid ${k}`);
 check(value.causationId===undefined||text(value.causationId),'SCHEMA_INVALID','Invalid causationId');
 check(Number.isSafeInteger(value.aggregateVersion)&&(value.aggregateVersion as number)>0&&iso(value.occurredAt),'SCHEMA_INVALID','Invalid version/time');
 check(record(value.payload),'SCHEMA_INVALID','Invalid payload');
 const p=value.payload; const type=value.eventType as EventType;
 check(Object.keys(p).every(k=>payloadFields[type].includes(k)),'SCHEMA_INVALID','Unknown payload field (permissions and secrets are forbidden)');
 for(const [k,v] of Object.entries(p))if(k!=='task'&&k!=='passed')check(text(v),'SCHEMA_INVALID',`Invalid payload ${k}`);
 if(type==='task.discovered')validateTask(p.task);
 if(type==='task.awaiting_approval'||type==='task.resumed')check(text(p.approvalId),'SCHEMA_INVALID','Missing approvalId');
 if(type==='task.validation_completed'||type==='task.review_completed')check(text(p.reportId)&&typeof p.passed==='boolean','SCHEMA_INVALID','Missing independent report');
 if(type==='task.evidence_recorded')check(text(p.evidenceRef),'SCHEMA_INVALID','Missing evidenceRef');
 if(type==='task.finished')check(['local_only','candidate_pr','merged_by_approved_actor'].includes(String(p.deliveryType)),'SCHEMA_INVALID','Missing delivery type');
}
export function applyEvent(previous:ForgeTask|undefined,event:ForgeEvent,authority:KernelAuthority):ForgeTask {
 validateEvent(event);check(authority?.kind==='kernel','UNAUTHORIZED','Only the trusted kernel accepts events');
 if(event.eventType==='task.discovered'){
  check(!previous,'INVALID_TRANSITION','Task exists');const task=structuredClone(event.payload.task) as ForgeTask;
  check(task.status==='DISCOVERED'&&task.version===0&&task.attempt===0&&task.permissions.length===0&&!task.runId&&!task.leaseUntil,'UNAUTHORIZED','Creation cannot grant permissions/state');
  check(task.id===event.aggregateId&&event.aggregateVersion===1,'INTEGRITY_FAILURE','Discovery identity mismatch');return {...task,version:1};
 }
 check(previous,'NOT_FOUND','Task missing');check(event.aggregateId===previous.id&&event.aggregateVersion===previous.version+1,'VERSION_CONFLICT','Aggregate version conflict');
 const t=structuredClone(previous);const active=!['DONE','CANCELLED','QUARANTINED'].includes(t.status);
 const from=(...states:TaskStatus[])=>check(states.includes(t.status),'INVALID_TRANSITION',`${event.eventType} rejected from ${t.status}`);
 const policy=()=>check(text(authority.policyDecisionId),'UNAUTHORIZED','Policy decision required');
 const lease=()=>{check(authority.lease&&authority.lease.runId===t.runId&&iso(authority.lease.leaseUntil)&&Date.parse(authority.lease.leaseUntil)>Date.parse(event.occurredAt)&&t.leaseUntil!==undefined&&Date.parse(t.leaseUntil)>Date.parse(event.occurredAt),'UNAUTHORIZED','Current unexpired lease required');};
 const release=()=>{delete t.runId;delete t.leaseUntil;};
 switch(event.eventType){
 case 'task.triaged':from('DISCOVERED');t.status='TRIAGED';break;
 case 'auth.requested':from('TRIAGED');t.status='AWAITING_AUTH';break;
 case 'auth.granted':from('TRIAGED','AWAITING_AUTH');policy();check(strings(authority.permissions),'UNAUTHORIZED','Policy permissions required');t.permissions=[...authority.permissions];t.status='QUEUED';break;
 case 'auth.denied':from('AWAITING_AUTH','WAITING_APPROVAL');policy();t.status='CANCELLED';break;
 case 'task.queued':case 'task.retried':from('FAILED');policy();check(authority.sideEffectsReconciled===true,'UNAUTHORIZED','Side-effect reconciliation required before retry');check(t.attempt<t.maxAttempts,'INVALID_TRANSITION','Attempts exhausted');t.status='QUEUED';release();break;
 case 'task.claimed':from('QUEUED');policy();check(authority.dependenciesSatisfied===true,'UNAUTHORIZED','Dependencies not verified');check(authority.lease&&text(authority.lease.runId)&&iso(authority.lease.leaseUntil)&&Date.parse(authority.lease.leaseUntil)>Date.parse(event.occurredAt),'UNAUTHORIZED','Lease required');check(t.attempt<t.maxAttempts,'INVALID_TRANSITION','Attempts exhausted');t.attempt++;t.runId=authority.lease.runId;t.leaseUntil=authority.lease.leaseUntil;t.status='CLAIMED';break;
 case 'task.started':from('CLAIMED');lease();t.status='RUNNING';break;
 case 'task.heartbeat':from('CLAIMED','RUNNING');lease();check(authority.lease!.leaseUntil>=t.leaseUntil!,'UNAUTHORIZED','Lease cannot shrink');t.leaseUntil=authority.lease!.leaseUntil;break;
 case 'task.awaiting_approval':from('RUNNING');lease();check(authority.approvalId===event.payload.approvalId,'UNAUTHORIZED','Persisted approval required');t.status='WAITING_APPROVAL';release();break;
 case 'task.resumed':from('WAITING_APPROVAL');policy();check(text(authority.approvalId)&&authority.approvalId===event.payload.approvalId,'UNAUTHORIZED','Authenticated approval required');t.status='QUEUED';break;
 case 'task.validation_started':from('RUNNING');lease();t.status='VALIDATING';release();break;
 case 'task.validation_completed':from('VALIDATING');check(event.payload.passed===true,'INVALID_TRANSITION','Validation did not pass');t.status='REVIEWING';break;
 case 'task.review_completed':from('REVIEWING');check(event.payload.passed===true,'INVALID_TRANSITION','Review did not pass');break;
 case 'task.pr_prepared':from('REVIEWING');t.status='PR_READY';break;
 case 'task.finished':from('PR_READY');if(event.payload.deliveryType==='merged_by_approved_actor')check(text(authority.approvalId),'UNAUTHORIZED','Merge approval required');t.status='DONE';release();break;
 case 'task.failed':from('RUNNING','VALIDATING','REVIEWING');if(t.status==='RUNNING')lease();t.status='FAILED';release();break;
 case 'task.cancelled':check(active,'INVALID_TRANSITION','Terminal task');t.status='CANCELLED';release();break;
 case 'task.quarantined':case 'policy.violation':check(active,'INVALID_TRANSITION','Terminal task');t.status='QUARANTINED';release();break;
 case 'task.lease_recovered':from('CLAIMED','RUNNING');check(t.leaseUntil&&Date.parse(t.leaseUntil)<=Date.parse(event.occurredAt)&&authority.sideEffectsReconciled===true,'UNAUTHORIZED','Expired lease and side-effect reconciliation required');t.status=t.attempt<t.maxAttempts?'QUEUED':'FAILED';release();break;
 case 'budget.exhausted':check(active,'INVALID_TRANSITION','Terminal task');t.status='FAILED';release();break;
 case 'task.evidence_recorded':check(active,'INVALID_TRANSITION','Terminal task');if(t.status==='RUNNING'||t.status==='CLAIMED')lease();break;
 }
 t.version=event.aggregateVersion;validateTask(t);return t;
}
