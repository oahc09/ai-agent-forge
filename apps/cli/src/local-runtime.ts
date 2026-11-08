import {lstatSync,mkdirSync,openSync,closeSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {EventStore} from '../../../packages/event-store/src/index.ts';
import {Scheduler} from '../../../packages/scheduler/src/index.ts';
export function localOperator():string {if(typeof process.getuid!=='function')throw new Error('M1 requires a POSIX local operator');return `local-uid:${process.getuid()}`;}
/** Local CLI's trusted control boundary. Worker code must never receive this directory. */
export function openLocalRuntime(path:string,create=false):{store:EventStore;scheduler:Scheduler;operator:string}{
 const root=resolve(path);const operator=localOperator();
 if(create&&!existsSync(root))mkdirSync(root,{mode:0o700});
 const stat=lstatSync(root);if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==process.getuid?.()||(stat.mode&0o077)!==0)throw new Error('State directory must be owned by this local operator, non-symlink and mode 0700');
 const db=join(root,'forge.sqlite');
 if(!existsSync(db)){if(!create)throw new Error('Runtime not initialized');closeSync(openSync(db,'wx',0o600));}
 const dbstat=lstatSync(db);if(!dbstat.isFile()||dbstat.isSymbolicLink()||dbstat.uid!==process.getuid?.()||(dbstat.mode&0o077)!==0)throw new Error('Database must be an owner-private regular file');
 const store=new EventStore(db);return {store,scheduler:new Scheduler(store),operator};
}
