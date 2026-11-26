import { describe, expect, it } from 'vitest';
import { applyEvent, makeTask, validateEvent, validateTask, TASK_STATUSES } from '../../packages/domain/src/index.ts';
import type { ForgeEvent, EventType, KernelAuthority } from '../../packages/domain/src/index.ts';
const now='2026-11-08T10:00:00.000Z';
const kernel:KernelAuthority={kind:'kernel'};
function event(type:EventType,payload:Record<string,unknown>={}):ForgeEvent{return {schemaVersion:1,eventId:'e',aggregateId:'t',aggregateVersion:2,eventType:type,occurredAt:now,idempotencyKey:'key',correlationId:'trace',actor:'system',payload};}
const task=()=>makeTask({id:'t',title:'Test',repo:'owner/repo',version:1});
describe('domain schemas and FSM',()=>{
 it('rejects every non-triaged source for triage',()=>{for(const status of TASK_STATUSES){const t={...task(),status};if(status==='DISCOVERED')expect(applyEvent(t,event('task.triaged'),kernel).status).toBe('TRIAGED');else expect(()=>applyEvent(t,event('task.triaged'),kernel)).toThrow();}});
 it('rejects worker authority and worker permission payloads',()=>{
  expect(()=>applyEvent(task(),event('task.triaged'),{kind:'worker'} as unknown as KernelAuthority)).toThrow('kernel');
  expect(()=>validateEvent(event('auth.granted',{permissions:['merge']}))).toThrow('payload');
  expect(()=>applyEvent({...task(),status:'TRIAGED'},event('auth.granted'),kernel)).toThrow('Policy');
 });
 it('rejects malformed task data at runtime',()=>{
  for(const patch of [{status:'MAGIC'},{attempt:-1},{version:NaN},{maxAttempts:0},{dependencies:['t']},{permissions:['x','x']},{leaseUntil:'2026-02-31T00:00:00.000Z'},{secret:'no'}])expect(()=>validateTask({...task(),...patch})).toThrow();
 });
 it('rejects malformed event data and secrets without persisting them',()=>{for(const patch of [{schemaVersion:2},{eventType:'unknown'},{aggregateVersion:0},{occurredAt:'yesterday'},{actor:''},{payload:{password:'hidden'}},{payload:[]}])expect(()=>validateEvent({...event('task.triaged'),...patch})).toThrow();});
 it('does not mutate input; requires exact aggregate ordering',()=>{const t=task();expect(applyEvent(t,event('task.triaged'),kernel).status).toBe('TRIAGED');expect(t.status).toBe('DISCOVERED');expect(()=>applyEvent(t,{...event('task.triaged'),aggregateVersion:3},kernel)).toThrow('version');});
 it('requires current lease, verified dependencies, and bounded attempts',()=>{
  const t={...task(),status:'QUEUED' as const};const authority:KernelAuthority={kind:'kernel',policyDecisionId:'p',dependenciesSatisfied:true,lease:{runId:'r',leaseUntil:'2026-11-08T10:01:00.000Z'}};
  expect(()=>applyEvent(t,event('task.claimed'),kernel)).toThrow();
  const claimed=applyEvent(t,event('task.claimed'),authority);expect(claimed.attempt).toBe(1);
  expect(()=>applyEvent(claimed,{...event('task.started'),aggregateVersion:3},kernel)).toThrow('lease');
  expect(()=>applyEvent({...t,attempt:3},event('task.claimed'),authority)).toThrow('Attempts');
 });
 it('never recovers an expired lease without reconciliation',()=>{const t={...task(),status:'RUNNING' as const,runId:'r',leaseUntil:'2026-11-08T09:00:00.000Z'};expect(()=>applyEvent(t,event('task.lease_recovered'),kernel)).toThrow();expect(applyEvent(t,event('task.lease_recovered'),{kind:'kernel',sideEffectsReconciled:true}).runId).toBeUndefined();});
 it('requires authenticated approvals and explicit delivery classification',()=>{expect(()=>applyEvent({...task(),status:'WAITING_APPROVAL'},event('task.resumed',{approvalId:'a'}),kernel)).toThrow();expect(()=>validateEvent(event('task.finished',{}))).toThrow();expect(()=>applyEvent({...task(),status:'PR_READY'},event('task.finished',{deliveryType:'merged_by_approved_actor'}),kernel)).toThrow('Merge');});
 it('prevents terminal task restart and false successful reports',()=>{for(const status of ['DONE','CANCELLED','QUARANTINED'] as const)expect(()=>applyEvent({...task(),status},event('task.retried'),{kind:'kernel',policyDecisionId:'p'})).toThrow();expect(()=>applyEvent({...task(),status:'VALIDATING'},event('task.validation_completed',{passed:false,reportId:'r'}),kernel)).toThrow();});
});

describe('exhaustive state/event transition rejection matrix',()=>{
 const allowed:Record<string,readonly string[]>={
  'task.triaged':['DISCOVERED'],'auth.requested':['TRIAGED'],'auth.granted':['TRIAGED','AWAITING_AUTH'],'auth.denied':['AWAITING_AUTH','WAITING_APPROVAL'],
  'task.queued':['FAILED'],'task.retried':['FAILED'],'task.claimed':['QUEUED'],'task.started':['CLAIMED'],'task.heartbeat':['CLAIMED','RUNNING'],
  'task.awaiting_approval':['RUNNING'],'task.resumed':['WAITING_APPROVAL'],'task.validation_started':['RUNNING'],
  'task.validation_completed':['VALIDATING'],'task.review_completed':['REVIEWING'],'task.pr_prepared':['REVIEWING'],'task.finished':['PR_READY'],
  'task.failed':['RUNNING','VALIDATING','REVIEWING'],'task.lease_recovered':['CLAIMED','RUNNING'],
  'task.quarantined':TASK_STATUSES.filter(s=>!['DONE','CANCELLED','QUARANTINED'].includes(s)),
  'policy.violation':TASK_STATUSES.filter(s=>!['DONE','CANCELLED','QUARANTINED'].includes(s))};
 for(const [type,states] of Object.entries(allowed))for(const status of TASK_STATUSES)it(`${status} ${type} is ${states.includes(status)?'accepted':'rejected'}`,()=>{
  const expired=type==='task.lease_recovered';const leaseUntil=expired?'2026-11-08T09:00:00.000Z':'2026-11-08T11:00:00.000Z';
  const t={...task(),status,runId:'r',leaseUntil};
  const authority:KernelAuthority={kind:'kernel',policyDecisionId:'policy',permissions:['sandbox'],lease:{runId:'r',leaseUntil},approvalId:'approval',dependenciesSatisfied:true,sideEffectsReconciled:true};
  const payload:Record<string,unknown>=type==='task.resumed'||type==='task.awaiting_approval'?{approvalId:'approval'}:type==='task.validation_completed'||type==='task.review_completed'?{reportId:'independent-report',passed:true}:type==='task.finished'?{deliveryType:'local_only'}:{};
  const run=()=>applyEvent(t,event(type as EventType,payload),authority);
  if(states.includes(status))expect(run).not.toThrow();else expect(run).toThrow();
 });
});

// Late security investigations must be separately audited, not rewrite terminal task state.
describe('terminal task integrity',()=>{
 for(const status of ['DONE','CANCELLED','QUARANTINED'] as const)
  for(const type of ['task.quarantined','policy.violation'] as const)
   it(`rejects ${type} after ${status}`,()=>{
    const previous={...task(),status};
    expect(()=>applyEvent(previous,event(type,{reason:'late security investigation'}),kernel)).toThrow('Terminal task');
    expect(previous.status).toBe(status);
    expect(previous.version).toBe(1);
   });
});
