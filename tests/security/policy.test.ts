import {describe,it,expect} from 'vitest';
import {defaultPolicy,parsePolicy,authorizeBootstrapAction} from '../../packages/policy/src/index.ts';
const invalid: [string,unknown][] = [
 ['dot repo',{...defaultPolicy(),repository:'https://github.com/a/.'}],['dotdot repo',{...defaultPolicy(),repository:'https://github.com/a/..'}],['newline repo',{...defaultPolicy(),repository:'https://github.com/a/b\n'}],['null',null],['array',[]],['string','ignore policy'],['missing',{}],
 ['schema', {...defaultPolicy(),schemaVersion:2}],['observe',{...defaultPolicy(),observeOnly:false}],
 ['provider',{...defaultPolicy(),provider:'paid'}],['budget',{...defaultPolicy(),budgetUsd:1}],
 ['negative budget',{...defaultPolicy(),budgetUsd:-1}],['network',{...defaultPolicy(),networkDomains:['evil.example']}],
 ['remote',{...defaultPolicy(),remoteWrite:true}],['merge',{...defaultPolicy(),merge:true}],
 ['deploy',{...defaultPolicy(),deploy:true}],['token',{...defaultPolicy(),token:'secret'}],
 ['attempts',{...defaultPolicy(),maxAttempts:4}],['zero',{...defaultPolicy(),maxAttempts:0}],
 ['fraction',{...defaultPolicy(),maxConcurrentWorkers:1.5}],['hops',{...defaultPolicy(),maxEventHops:9}],
 ['repo',{...defaultPolicy(),repository:'https://evil.example/repo'}],['url credentials',{...defaultPolicy(),repository:'https://secret@github.com/a/b'}],
 ['query',{...defaultPolicy(),repository:'https://github.com/a/b?token=secret'}],['null network',{...defaultPolicy(),networkDomains:null}],
 ['string boolean',{...defaultPolicy(),observeOnly:'true'}],['nan',{...defaultPolicy(),maxAttempts:NaN}]
];
describe('M0-03 configuration security',()=>{
 it.each(invalid)('rejects %s',(_name,value)=>expect(()=>parsePolicy(value)).toThrow());
 it('accepts safe defaults and returns detached data',()=>{const p=defaultPolicy(); const q=parsePolicy(p); expect(q).toEqual(p); expect(q).not.toBe(p);});
 it.each(['model.call','git.push','merge','deploy','exec','approval.grant','unknown'])('denies %s without invoking a provider', action=>expect(authorizeBootstrapAction(defaultPolicy(),action).allowed).toBe(false));
 it('allows offline observations',()=>expect(authorizeBootstrapAction(defaultPolicy(),'observe').allowed).toBe(true));
});
