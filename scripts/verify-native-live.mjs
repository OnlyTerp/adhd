// Opt-in real subscription-host acceptance. Never run as part of the unit gate.
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {Store} from '../native/store.mjs';

const directory=process.argv[2],thinkerSpeed=process.argv[3]??'priority';if(!directory)throw new Error('Provide a dedicated acceptance directory (optional second argument: priority or ultrafast)');
if(!['priority','ultrafast'].includes(thinkerSpeed))throw new Error('Unknown thinker speed');
mkdirSync(directory,{recursive:true});
const proc=spawn(process.execPath,[fileURLToPath(new URL('../native/mcp.mjs',import.meta.url))],{windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,GOAL_LOOP_DATA:path.join(directory,'data')}});
const sourceManifest=Object.fromEntries(['native/runtime.mjs','native/store.mjs','native/client.mjs','native/identity.mjs','native/feedback.mjs','native/tools.mjs','native/mcp.mjs','native/server.mjs','native/browser.js','native/renderer.mjs','native/assets/renderer.js','worker/ui.js','package-lock.json'].map(file=>[file,createHash('sha256').update(readFileSync(new URL('../'+file,import.meta.url))).digest('hex')]));
const pending=new Map(),ids=[],receipts={startedAt:new Date().toISOString(),machine:process.platform,sourceManifest,stages:[]};let seq=0,stderr='',closed=false;
proc.stderr.on('data',b=>{stderr=(stderr+b).slice(-4000);});
const lines=createInterface({input:proc.stdout});lines.on('line',line=>{const m=JSON.parse(line),p=pending.get(m.id);if(!p)return;pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result);});
proc.on('exit',()=>{closed=true;for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('MCP exited: '+stderr));}pending.clear();});
function request(method,params={}){return new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(new Error('MCP request deadline: '+method));},30000);pending.set(id,{resolve,reject,timer});proc.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});}
async function call(name,args={}){return (await request('tools/call',{name,arguments:args})).structuredContent;}
function record(stage,data){const entry={stage,at:new Date().toISOString(),...data};receipts.stages.push(entry);writeFileSync(path.join(directory,'receipts.json'),JSON.stringify(receipts,null,2));console.log(JSON.stringify(entry));}
async function until(id,label,predicate,timeout=240000){
  const end=Date.now()+timeout;let previous='';
  while(Date.now()<end){const s=await call('goal_loop_status',{sessionId:id});const signature=[s.state,s.run.sourceCount,s.revision,s.run.recorder?.status].join('/');if(signature!==previous){record(label,{id,state:s.state,sources:s.run.sourceCount,revisions:s.revision,recorder:s.run.recorder?.status});previous=signature;}if(predicate(s))return s;if(['failed','interrupted','recording_failed'].includes(s.state))throw new Error('Unexpected terminal state: '+JSON.stringify(s.run));await new Promise(r=>setTimeout(r,500));}
  throw new Error('Acceptance deadline: '+label);
}
const deadline=setTimeout(()=>{record('hard_deadline',{});proc.stdin.end();},540000);
try{
  await request('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'goal-loop-live-acceptance',version:'1'}});
  const list=await request('tools/list');assert.ok(list.tools.some(t=>t.name==='goal_loop_evidence'));
  const goal='This is a labeled synthetic acceptance exercise, not external research. Keep each round below 120 words. In round 1 explain that a widget count of 7 is only an unverified estimate. Include the literal GOALLOOPMATHPLACEHOLDER999END, a fenced Python snippet double_count(n), and the equation \\(d=2n\\). Round 1 MUST end with loop:continue, even if the math is easy. On the next round inspect the latest supplied evidence and tracker corrections: if an observed count of 9 is present, retract the estimate, derive double count 18, cite the evidence ID, preserve the fact that this is a synthetic fixture, and end loop:complete. Otherwise identify the missing measurement and continue. Never call tools. Do not claim you executed the code.';
  const thinker={modelId:'gpt-6-astra',speedId:thinkerSpeed,reasoning:'max'};
  const first=await call('goal_loop_start',{requestId:'live-multi-stop-'+Date.now(),goal,configuration:{thinkers:[thinker,thinker],maxRounds:3,maxMinutes:8}});ids.push(first.id);record('multi_started',{id:first.id,url:first.url});
  await until(first.id,'multi_admission',s=>s.run.thinkers.length===2&&s.run.thinkers.every(a=>a.status==='thinking'));
  await call('goal_loop_control',{sessionId:first.id,action:'pause'});
  const paused=await until(first.id,'multi_pause',s=>s.state==='paused'&&s.run.sourceCount===2&&s.run.trackerBusy);
  assert.equal(paused.run.thinkers.every(a=>a.round===1),true);
  const stopped=await call('goal_loop_control',{sessionId:first.id,action:'stop'});assert.equal(stopped.state,'stopped');assert.equal(stopped.run.error,null);assert.equal(stopped.run.termination.status,'confirmed');assert.equal(stopped.run.sourceCount,2);assert.equal(stopped.run.toolCalls,0);record('active_tracker_stopped',{id:first.id,run:stopped.run});
  await call('goal_loop_control',{sessionId:first.id,action:'recover_recording',trackerContextBytes:4194304});
  const recovered=await until(first.id,'recording_recovery',s=>s.state==='stopped'&&s.run.recorder.pendingSources===0);
  assert.equal(recovered.run.thinkers.length,0);assert.equal(recovered.run.sourceCount,2);assert.equal(recovered.run.recorder.contextBudgetBytes,4194304);record('recovered_without_thinkers',{id:first.id,run:recovered.run});
  const second=await call('goal_loop_start',{requestId:'live-evidence-'+Date.now(),goal,configuration:{thinkers:[thinker],maxRounds:3,maxMinutes:8}});ids.push(second.id);record('feedback_started',{id:second.id,url:second.url});
  await until(second.id,'feedback_admission',s=>s.run.thinkers[0]?.status==='thinking');await call('goal_loop_control',{sessionId:second.id,action:'pause'});
  await until(second.id,'first_recorded',s=>s.state==='paused'&&s.revision>=1);
  const evidence={sessionId:second.id,requestId:'measurement-9',expectedInputRevision:1,text:'Observed synthetic fixture count is 9. This supersedes the unverified estimate 7. This is a supplied acceptance observation, not a production benchmark.',provenance:'verify-native-live.mjs controlled acceptance input',sourceRevision:'fixture-v2',observedAt:new Date().toISOString(),status:'observed'};
  const evidenceReceipt=await call('goal_loop_evidence',evidence);assert.equal((await call('goal_loop_evidence',evidence)).replayed,true);record('evidence_saved',{id:second.id,evidenceReceipt});
  await call('goal_loop_control',{sessionId:second.id,action:'recover_recording'}); // Explicit paused-fixture reconciliation, never a production thinker gate.
  await until(second.id,'evidence_recorded',s=>s.state==='paused'&&s.run.recordedInputRevision===2);
  await call('goal_loop_control',{sessionId:second.id,action:'resume'});
  const completed=await until(second.id,'feedback_completed',s=>s.state==='completed');assert.equal(completed.run.sourceCount,2);assert.equal(completed.run.toolCalls,0);
  const sources=await call('goal_loop_read',{sessionId:second.id,view:'sources'});assert.equal(sources.items[1].input_revision,2);assert.ok(sources.items[1].feedback_revision>=2);assert.match(sources.items[1].text,/\b9\b/);assert.match(sources.items[1].text,/\b18\b/);assert.ok(sources.items[1].text.includes(evidenceReceipt.evidenceId));
  const content=await call('goal_loop_read',{sessionId:second.id,view:'synthesis'});assert.match(content.markdown,/\b18\b/);assert.ok(content.feedback.findings.some(f=>f.evidenceIds.includes(evidenceReceipt.evidenceId)));
  const pack=await call('goal_loop_export',{sessionId:second.id}),bundle=JSON.parse(readFileSync(pack.path,'utf8'));assert.equal(Store.verifyPackage(bundle).valid,true);
  const restoredStore=new Store(path.join(directory,'restored'));const restored=restoredStore.restore(bundle,'acceptance-restore');assert.equal(restoredStore.document(restored.id),bundle.payload.markdown);restoredStore.close();
  record('passed',{id:second.id,url:second.url,run:completed.run,package:pack,restore:restored});
  console.log('LIVE_ACCEPTANCE_PASSED; viewer remains available until quit or the bounded deadline.');
  const input=createInterface({input:process.stdin});await new Promise(resolve=>{input.on('line',line=>{if(line.trim()==='quit'){input.close();resolve();}});proc.once('exit',resolve);});
}catch(e){record('failed',{message:e.message});process.exitCode=1;for(const id of ids)try{await call('goal_loop_control',{sessionId:id,action:'stop'});}catch{}}
finally{clearTimeout(deadline);if(!closed){proc.stdin.end();await new Promise(resolve=>{proc.once('exit',resolve);const timer=setTimeout(()=>{proc.kill();resolve();},10000);timer.unref();});}lines.close();}
