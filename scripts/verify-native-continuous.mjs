// Opt-in real subscription acceptance. No thinker pauses or recorder gates.
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import {Store,digest} from '../native/store.mjs';

const directory=process.argv[2];if(!directory)throw new Error('Provide an isolated acceptance directory');
mkdirSync(directory,{recursive:true});
const files=['native/runtime.mjs','native/store.mjs','native/client.mjs','native/claude.mjs','native/router.mjs','native/identity.mjs','native/feedback.mjs','native/tools.mjs','native/mcp.mjs','native/server.mjs','native/browser.js','native/renderer.mjs','native/assets/renderer.js','worker/ui.js','package-lock.json'];
const sourceManifest=Object.fromEntries(files.map(file=>[file,digest(readFileSync(new URL('../'+file,import.meta.url),'utf8'))]));
const proc=spawn(process.execPath,[fileURLToPath(new URL('../native/mcp.mjs',import.meta.url))],{windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,GOAL_LOOP_DATA:path.join(directory,'data')}});
const pending=new Map(),receipts={startedAt:new Date().toISOString(),machine:process.platform,sourceManifest,stages:[]};let seq=0,stderr='',closed=false,sessionId;
proc.stderr.on('data',b=>{stderr=(stderr+b).slice(-4000);});
const lines=createInterface({input:proc.stdout});lines.on('line',line=>{const m=JSON.parse(line),p=pending.get(m.id);if(!p)return;pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result);});
proc.on('exit',()=>{closed=true;for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('MCP exited: '+stderr));}pending.clear();});
function request(method,params={}){return new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(new Error('MCP request deadline: '+method));},30000);pending.set(id,{resolve,reject,timer});proc.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});}
async function call(name,args={}){return (await request('tools/call',{name,arguments:args})).structuredContent;}
function record(stage,data){const entry={stage,at:new Date().toISOString(),...data};receipts.stages.push(entry);writeFileSync(path.join(directory,'receipts.json'),JSON.stringify(receipts,null,2));console.log(JSON.stringify(entry));}
// Optional worker choice, e.g. GOAL_LOOP_VERIFY_THINKER='{"modelId":"claude-opus-5-5","speedId":"standard","reasoning":"max"}'.
const thinker=JSON.parse(process.env.GOAL_LOOP_VERIFY_THINKER||'{"modelId":"gpt-6-astra","speedId":"ultrafast","reasoning":"max"}');
const tracker=process.env.GOAL_LOOP_VERIFY_TRACKER?JSON.parse(process.env.GOAL_LOOP_VERIFY_TRACKER):undefined;
const minutes=Number(process.env.GOAL_LOOP_VERIFY_MINUTES||4),rounds=Number(process.env.GOAL_LOOP_VERIFY_ROUNDS||6);
receipts.workers={thinker,tracker:tracker??'default',rounds};
const deadline=setTimeout(()=>{record('hard_deadline',{});proc.stdin.end();},(minutes+1)*60000);
try{
  await request('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'goal-loop-continuous-acceptance',version:'1'}});
  const goal='Labeled synthetic acceptance exercise, not external research. Publish '+rounds+' short useful rounds, each below 140 words. Initially a widget count of 7 is an unverified estimate. Round 1: explain that uncertainty and derive d=2n conditionally. Later rounds: when supplied observed evidence says the count is 9, correct the estimate, derive 18 and cite its exact evidence ID. Examine a different boundary case or implication each round. Explain any relevant tracker correction when available. Every round ends with <!-- loop:continue -->; the host owns the explicit '+rounds+'-round test bound. Never wait for tools or evidence, never claim to execute tests.';
  const started=await call('goal_loop_start',{requestId:'continuous-acceptance-'+Date.now(),goal,configuration:{thinkers:[thinker],...(tracker?{tracker}:{}),maxRounds:rounds,maxMinutes:minutes,maxPending:1}});
  sessionId=started.id;record('started',{id:sessionId,url:started.url,configuration:started.run.config});
  let evidenceReceipt,unrecordedVisible=false,overlapObserved=false,previous='',completed;
  for(;;){
    const s=await call('goal_loop_status',{sessionId}),signature=[s.state,s.run.sourceCount,s.revision].join('/');
    if(signature!==previous){record('progress',{state:s.state,sources:s.run.sourceCount,revisions:s.revision,thinkers:s.run.thinkers,metrics:s.run.metrics});previous=signature;}
    if(s.run.sourceCount){
      const sources=await call('goal_loop_read',{sessionId,view:'sources',limit:20}),content=await call('goal_loop_read',{sessionId,view:'synthesis'});
      for(const source of sources.items)assert.ok(content.markdown.includes(source.text),'Main document must preserve each source verbatim');
      if(s.run.sourceCount>s.run.recordedCount)unrecordedVisible=true;
      if(s.run.trackerBusy&&s.run.thinkers.some(a=>a.round>=2&&a.status==='thinking'))overlapObserved=true;
      if(!evidenceReceipt){
        const evidence={sessionId,requestId:'observed-count-9',expectedInputRevision:1,text:'The observed count in this synthetic fixture is 9, correcting the unverified estimate 7. Thus d=2n gives 18. This is controlled test input, not a production performance observation.',provenance:'verify-native-continuous.mjs supplied fixture observation',sourceRevision:'synthetic-fixture-v2',observedAt:new Date().toISOString(),status:'observed'};
        evidenceReceipt=await call('goal_loop_evidence',evidence);assert.equal((await call('goal_loop_evidence',evidence)).replayed,true);
        record('evidence_while_thinking',{receipt:evidenceReceipt,thinkers:s.run.thinkers});
      }
    }
    if(['failed','interrupted','recording_failed','stopped','blocked','completed'].includes(s.state))throw new Error('Unexpected terminal state: '+s.state+' '+JSON.stringify(s.run));
    if(s.state==='limited'){completed=s;break;}
    await new Promise(resolve=>setTimeout(resolve,250));
  }
  assert.equal(completed.run.sourceCount,rounds);assert.equal(completed.run.recordedCount,rounds);assert.equal(completed.run.toolCalls,0);assert.equal(completed.run.termination.status,'confirmed');assert.ok(unrecordedVisible);assert.ok(overlapObserved);
  const pack=await call('goal_loop_export',{sessionId}),bundle=JSON.parse(readFileSync(pack.path,'utf8')),p=bundle.payload;
  assert.equal(Store.verifyPackage(bundle).valid,true);
  assert.ok(p.sources.some(s=>s.input_revision===2&&s.text.includes(evidenceReceipt.evidenceId)&&/\b18\b/.test(s.text)),'Observed evidence reaches a later thinker publication without pause');
  assert.ok(p.sources.some(s=>s.feedback_revision>0),'Accepted tracker feedback reaches a later thinker round');
  assert.ok(p.revisions.some(r=>JSON.parse(r.feedback).findings.some(f=>f.evidenceIds.includes(evidenceReceipt.evidenceId))),'Tracker feedback cites observed evidence');
  for(const source of p.sources)assert.ok(p.markdown.includes(source.text));for(const revision of p.revisions)assert.ok(p.markdown.includes(revision.markdown));
  const admissions=p.audit.filter(a=>a.role==='thinker'&&a.type==='admission').map(a=>JSON.parse(a.data)),gaps=admissions.map(a=>a.interTurnGapMs).filter(Number.isFinite).sort((a,b)=>a-b);
  assert.equal(gaps.length,rounds-1);assert.ok(Math.max(...gaps)<1000,'Host continuation must not wait for the tracker');
  const trackerAdmission=p.audit.find(a=>a.role==='tracker'&&a.type==='admission'),secondThinker=p.audit.filter(a=>a.role==='thinker'&&a.type==='admission')[1];assert.ok(secondThinker.sequence<trackerAdmission.sequence,'Next thinker dispatch precedes first tracker hook');
  const restoredStore=new Store(path.join(directory,'restored'));let restored;try{restored=restoredStore.restore(bundle,'continuous-acceptance-restore');assert.equal(restoredStore.document(restored.id),p.markdown);}finally{restoredStore.close();}
  record('passed',{id:sessionId,url:started.url,run:completed.run,unrecordedVisible,overlapObserved,evidenceReceipt,gapsMs:gaps,medianGapMs:gaps[Math.floor(gaps.length/2)],maxGapMs:Math.max(...gaps),sourceCoverage:p.sources.map(s=>({id:s.uid,round:s.round,inputRevision:s.input_revision,feedbackRevision:s.feedback_revision,bytes:Buffer.byteLength(s.text)})),package:pack,restore:restored});
}catch(e){record('failed',{message:e.message,stack:e.stack});process.exitCode=1;if(sessionId)try{await call('goal_loop_control',{sessionId,action:'stop'});}catch{}}
finally{clearTimeout(deadline);if(!closed){proc.stdin.end();await new Promise(resolve=>{proc.once('exit',resolve);const timer=setTimeout(()=>{proc.kill();resolve();},10000);timer.unref();});}lines.close();}
