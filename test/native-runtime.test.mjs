import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {request} from 'node:http';
import {Store} from '../native/store.mjs';
import {Runtime} from '../native/runtime.mjs';
import {serve} from '../native/server.mjs';

function setup(t,mode='normal'){
  const dir=mkdtempSync(path.join(process.env.GOAL_LOOP_TEST_TMP||tmpdir(),'goal-loop-'));
  const store=new Store(dir);let client;
  class FakeHost extends EventEmitter{
    constructor(){super();this.closed=false;this.threads=[];this.counts=new Map();this.thinkerTwoBeforeTrackerSaved=false;client=this;}
    async initialize(){this.account={type:'chatgpt'};return this;}
    validate(){}
    catalog(){return {verified:true};}
    async thread(choice){const a={threadId:'thread-'+this.threads.length,model:choice.modelId,modelProvider:'openai',serviceTier:choice.speedId,reasoningEffort:'max'};this.threads.push(a);return a;}
    async request(method,p){
      if(method==='turn/interrupt')return {};
      if(method!=='turn/start')throw new Error('Unexpected method');
      const n=(this.counts.get(p.threadId)||0)+1;this.counts.set(p.threadId,n);
      const turnId=p.threadId+'-turn-'+n,tracker=p.model==='gpt-6.1-terra';
      if(!tracker&&n===2)this.thinkerTwoBeforeTrackerSaved=!store.latest(id);
      const publish=()=>{
        if(this.closed)return;
        if(mode==='tool'&&!tracker){this.emit('notification',{method:'item/started',params:{threadId:p.threadId,turnId,item:{type:'commandExecution'}}});return;}
        const text=tracker?(mode==='bad-tracker'?'invalid document':JSON.stringify({markdown:'## Findings\n\nSource rounds are mathematical proposals.',feedback:{findings:[],questions:[],nextDirections:[]}})):`Published round ${n}\n<!-- loop:${n===1?'continue':'complete'} -->`;
        this.emit('notification',{method:'item/completed',params:{threadId:p.threadId,turnId,item:{type:'agentMessage',id:turnId+'-item',text,phase:'final_answer'}}});
        this.emit('notification',{method:'turn/completed',params:{threadId:p.threadId,turn:{id:turnId,status:'completed'}}});
      };
      if(tracker){setTimeout(publish,30);}else if(mode==='late'){setTimeout(publish,10);}else publish(); // Deliberately before turn/start response.
      return {turn:{id:turnId,status:'inProgress'}};
    }
    async close(){if(this.closed)return;this.closed=true;this.emit('disconnect',new Error('owned host closed'));}
  }
  const runtime=new Runtime(store,{clientFactory:()=>new FakeHost()});
  const id=store.prepare({goal:'Native research contract test',requestId:'request-1'});
  t.after(async()=>{await runtime.close();store.close();rmSync(dir,{recursive:true,force:true});});
  return {store,runtime,id,get client(){return client;}};
}
const config={thinkers:[{modelId:'gpt-6-astra',speedId:'priority',reasoning:'max'}],maxRounds:2,maxMinutes:1};
async function done(runtime,id){await runtime.runs.get(id).task;return runtime.status(id,{includeDocument:true});}

test('real queue contract: early terminal events, no thinker wait for tracker, exact sources and drained document',async t=>{
  const s=setup(t);s.runtime.start(s.id,config);const result=await done(s.runtime,s.id);
  assert.equal(result.state,'completed');assert.equal(result.run.sourceCount,2);assert.ok(result.revision>=1);assert.equal(result.run.recordedCount,2);assert.equal(result.run.recorder.pendingSources,0);assert.equal(result.run.toolCalls,0);
  assert.equal(s.client.thinkerTwoBeforeTrackerSaved,true);assert.match(result.document,/Published round 1/);assert.match(result.document,/Published round 2/);
});
test('replayed start cannot re-admit and changed configuration is rejected',async t=>{
  const s=setup(t);s.runtime.start(s.id,config);s.runtime.start(s.id,config);await done(s.runtime,s.id);
  assert.equal(s.client.threads.length,2);assert.throws(()=>s.runtime.start(s.id,{...config,maxRounds:3}),/different immutable/);
});
test('tool event stops owned host and preserves truthful failure',async t=>{
  const s=setup(t,'tool');s.runtime.start(s.id,config);await done(s.runtime,s.id);
  assert.equal(s.runtime.status(s.id).state,'failed');assert.equal(s.runtime.status(s.id).run.toolCalls,1);assert.equal(s.client.closed,true);
});
test('stop during admission produces stopped, not completion or a fresh launch',async t=>{
  const s=setup(t,'late');s.runtime.start(s.id,config);await s.runtime.control(s.id,'stop');await done(s.runtime,s.id);
  assert.equal(s.runtime.status(s.id).state,'stopped');assert.equal(s.client.closed,true);
});
test('loopback HTTP rejects cross-origin mutations and DNS rebinding',async t=>{
  const s=setup(t);const web=await serve(s.runtime);t.after(()=>web.close());
  assert.equal((await fetch(web.url(s.id))).status,200);
  const bad=await fetch(web.origin+'/api/runtime/start',{method:'POST',headers:{origin:'https://unrelated.example','content-type':'application/json'},body:JSON.stringify({sessionId:s.id,configuration:config})});
  assert.equal(bad.status,403);assert.equal(s.store.run(s.id),null);
  const wrongHost=await new Promise((resolve,reject)=>{const req=request(web.url(s.id),{headers:{host:'unrelated.example'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end();});assert.equal(wrongHost,403);
});
test('dead controller is marked interrupted and never re-admitted',async t=>{
  const s=setup(t);s.store.reserve(s.id,config);s.store.db.prepare('UPDATE runs SET owner_pid=? WHERE session_id=?').run(2147483647,s.id);
  s.store.recover();assert.equal(s.store.run(s.id).state,'interrupted');assert.equal(s.store.reserve(s.id,config),false);
});
test('tracker failure retains complete published source and reports recording separately',async t=>{
  const s=setup(t,'bad-tracker');s.runtime.start(s.id,config);await done(s.runtime,s.id);
  assert.equal(s.runtime.status(s.id).state,'recording_failed');assert.equal(s.runtime.status(s.id).run.outcome,'completed');assert.equal(s.store.sources(s.id).length,2);assert.match(s.store.document(s.id),/Published round 1/);assert.equal(s.store.latest(s.id),undefined);
});
test('a round limit is reported as limited rather than objective completion',async t=>{
  const s=setup(t);s.runtime.start(s.id,{...config,maxRounds:1});const r=await done(s.runtime,s.id);assert.equal(r.state,'limited');assert.equal(r.run.reason,'round_limit');assert.equal(r.revision,1);
});
test('multiple thinkers preserve individual provenance through one serialized tracker',async t=>{
  const s=setup(t);s.runtime.start(s.id,{...config,thinkers:[config.thinkers[0],{...config.thinkers[0]}]});const r=await done(s.runtime,s.id);
  assert.equal(r.state,'completed');assert.equal(s.client.threads.length,3);assert.equal(r.run.sourceCount,4);assert.deepEqual(s.store.sources(s.id).map(x=>x.thinker).sort(),[1,1,2,2]);assert.equal(s.store.latest(s.id).through_source,s.store.sources(s.id).at(-1).sequence);
});
