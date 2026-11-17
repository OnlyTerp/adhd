import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Store} from '../native/store.mjs';
import {readSeed,toolService,schemas} from '../native/tools.mjs';

function dir(t){const d=mkdtempSync(path.join(process.env.GOAL_LOOP_TEST_TMP||tmpdir(),'loop-seed-'));t.after(()=>rmSync(d,{recursive:true,force:true}));return d;}

test('goal and context can come from absolute UTF-8 files; a BOM is dropped',t=>{
  const d=dir(t),goal=path.join(d,'goal.txt'),context=path.join(d,'context.md');
  writeFileSync(goal,'\uFEFFFind the bound.');writeFileSync(context,'ctx 🧪 '.repeat(30000));
  const seed=readSeed({requestId:'r',goalFile:goal,contextFile:context});
  assert.equal(seed.goal,'Find the bound.');assert.equal(seed.context,'ctx 🧪 '.repeat(30000));assert.equal(seed.goalFile,undefined);
  assert.deepEqual(readSeed({requestId:'r',goal:'g'}),{requestId:'r',goal:'g'},'inline input passes through unchanged');
});

test('seed files are refused clearly',t=>{
  const d=dir(t),ok=path.join(d,'ok.txt'),big=path.join(d,'big.txt'),bad=path.join(d,'bad.txt');
  writeFileSync(ok,'x');writeFileSync(big,'x'.repeat(500004));writeFileSync(bad,Buffer.from([0x66,0xff,0x66]));
  assert.throws(()=>readSeed({requestId:'r',goal:'g',goalFile:ok}),/Pass goal or goalFile, not both/);
  assert.throws(()=>readSeed({requestId:'r',goal:'g',contextFile:'relative.md'}),/contextFile must be an absolute path/);
  assert.throws(()=>readSeed({requestId:'r',goal:'g',contextFile:path.join(d,'missing.md')}),/contextFile could not be read \(ENOENT\)/);
  assert.throws(()=>readSeed({requestId:'r',goal:'g',contextFile:big}),/contextFile is 500004 bytes; the limit is 500000/);
  assert.throws(()=>readSeed({requestId:'r',goal:'g',contextFile:bad}),/contextFile is not valid UTF-8/);
  assert.throws(()=>readSeed({requestId:'r',context:'c'}),/Provide goal or goalFile/);
});

test('goal_loop_start stores file content and stays idempotent on retry',async t=>{
  const d=dir(t),store=new Store(path.join(d,'data'));
  const context=path.join(d,'seed.md');writeFileSync(context,'Seed from an earlier run.\n'.repeat(8000));
  const started=[];const runtime={store,start:(id,configuration)=>{started.push({id,configuration});return {id,state:'starting'};}};
  const call=toolService(runtime,{url:id=>'local/'+id}),args={requestId:'seeded',goal:'Revise the drafts.',contextFile:context,configuration:{thinkers:[{backend:'claude',modelId:'m'}],maxRounds:3,maxMinutes:5}};
  const a=await call('goal_loop_start',args),b=await call('goal_loop_start',args);
  assert.equal(a.id,b.id);assert.equal(store.workspace(a.id).context,'Seed from an earlier run.\n'.repeat(8000));assert.equal(started[0].configuration.maxRounds,3);
  assert.deepEqual(schemas.goal_loop_start.inputSchema.required,['requestId']);
  store.close();
});
