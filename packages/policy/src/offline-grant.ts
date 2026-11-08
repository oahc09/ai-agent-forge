import {randomUUID} from 'node:crypto';
import {authorizeBootstrapAction,parsePolicy} from './index.ts';
export interface OfflineGrant { id:string; taskId:string; repo:string; permissions:['fake.run']; actor:string; expiresAt:number }
/** Privileged host API, never exposed to candidate/worker processes. */
export function issueOfflineGrant(policy:unknown, input:{taskId:string;repo:string;actor:string;now:number}):OfflineGrant {
 const checked=parsePolicy(policy);
 if (!authorizeBootstrapAction(checked,'offline-fixture').allowed || input.repo!==checked.repository) throw new Error('Repository not authorized');
 if (!input.actor || !input.taskId || !Number.isSafeInteger(input.now) || input.now<0) throw new Error('Invalid trusted authority input');
 return {id:randomUUID(),taskId:input.taskId,repo:input.repo,permissions:['fake.run'],actor:input.actor,expiresAt:input.now+86_400_000};
}
