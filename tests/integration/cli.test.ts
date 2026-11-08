import {it,expect} from 'vitest';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
it('initializes safely, diagnoses gaps, refuses overwrite and runtime commands',()=>{
 const dir=mkdtempSync(join(tmpdir(),'forge-cli-')); const path=join(dir,'policy.json');
 const call=(...args:string[])=>spawnSync(process.execPath,['apps/cli/src/index.ts',...args],{encoding:'utf8',env:{PATH:process.env.PATH}});
 try {expect(call('init',path).status).toBe(0);expect(JSON.parse(readFileSync(path,'utf8')).observeOnly).toBe(true);expect(call('init',path).status).toBe(1);expect(JSON.parse(call('doctor',path).stdout).runtimeReady).toBe(false);expect(call('run').status).toBe(1);expect(call('doctor',join(dir,'absent')).status).toBe(1);}finally{rmSync(dir,{recursive:true});}
});
