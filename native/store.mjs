import {homedir} from 'node:os';
import {join as joinPath} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,writeFileSync,renameSync} from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {processIdentity,sameProcess} from './identity.mjs';

const ownProcess=processIdentity(process.pid);
export const terminalStates=['completed','stopped','failed','interrupted','limited','blocked','recording_failed','restored'];
export const digest=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const iso=()=>new Date().toISOString();
const bounded=(s,label,max)=>{if(typeof s!=='string'||!s.trim()||Buffer.byteLength(s)>max)throw new Error('Invalid '+label);return s;};
const pageSize=n=>Math.max(1,Math.min(20,Number.isInteger(n)?n:5));

export class Store {
  constructor(directory){
    this.directory=directory;this.instance=randomUUID();mkdirSync(directory,{recursive:true});this.db=new DatabaseSync(path.join(directory,'studio.sqlite'));
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;"+
      "CREATE TABLE IF NOT EXISTS workspaces(id TEXT PRIMARY KEY,request_id TEXT UNIQUE NOT NULL,goal TEXT NOT NULL,context TEXT NOT NULL,created_at TEXT NOT NULL);"+
      "CREATE TABLE IF NOT EXISTS runs(session_id TEXT PRIMARY KEY,config TEXT NOT NULL,state TEXT NOT NULL,owner_pid INTEGER NOT NULL,detail TEXT NOT NULL);"+
      "CREATE TABLE IF NOT EXISTS sources(sequence INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT NOT NULL,event_id TEXT NOT NULL,thinker INTEGER NOT NULL,round INTEGER NOT NULL,thread_id TEXT NOT NULL,turn_id TEXT NOT NULL,model TEXT NOT NULL,text TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(session_id,event_id));"+
      "CREATE TABLE IF NOT EXISTS revisions(sequence INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT NOT NULL,through_source INTEGER NOT NULL,markdown TEXT NOT NULL,created_at TEXT NOT NULL);"+
      "CREATE TABLE IF NOT EXISTS audit(sequence INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT NOT NULL,role TEXT NOT NULL,type TEXT NOT NULL,data TEXT NOT NULL,created_at TEXT NOT NULL);"+
      "CREATE TABLE IF NOT EXISTS controllers(instance TEXT PRIMARY KEY,pid INTEGER NOT NULL,identity TEXT NOT NULL);"+
      "CREATE TABLE IF NOT EXISTS evidence(sequence INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT NOT NULL,uid TEXT NOT NULL,request_id TEXT NOT NULL,payload TEXT NOT NULL,hash TEXT NOT NULL,input_revision INTEGER NOT NULL,created_at TEXT NOT NULL,UNIQUE(session_id,request_id));"+
      "CREATE TABLE IF NOT EXISTS packets(session_id TEXT NOT NULL,revision INTEGER NOT NULL,data TEXT NOT NULL,hash TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(session_id,revision));"+
      "CREATE TABLE IF NOT EXISTS exports(session_id TEXT PRIMARY KEY,source_head INTEGER NOT NULL,revision_head INTEGER NOT NULL,input_revision INTEGER NOT NULL,path TEXT,error TEXT,updated_at TEXT NOT NULL);"+
      "CREATE TABLE IF NOT EXISTS reservations(session_id TEXT NOT NULL,operation_id TEXT PRIMARY KEY,epoch INTEGER NOT NULL,bytes INTEGER NOT NULL,created_at TEXT NOT NULL);"+
      "CREATE INDEX IF NOT EXISTS source_session ON sources(session_id,sequence);CREATE INDEX IF NOT EXISTS revision_session ON revisions(session_id,sequence);CREATE INDEX IF NOT EXISTS audit_session ON audit(session_id,sequence);");
    for(const [table,columns] of Object.entries({runs:{owner_token:"TEXT NOT NULL DEFAULT ''",epoch:'INTEGER NOT NULL DEFAULT 1'},sources:{uid:"TEXT NOT NULL DEFAULT ''",input_revision:'INTEGER NOT NULL DEFAULT 1',feedback_revision:'INTEGER NOT NULL DEFAULT 0'},revisions:{input_revision:'INTEGER NOT NULL DEFAULT 1',feedback:"TEXT NOT NULL DEFAULT '{}' "}})){
      const known=this.db.prepare('PRAGMA table_info('+table+')').all().map(c=>c.name);
      for(const [name,type] of Object.entries(columns))if(!known.includes(name))this.db.exec('ALTER TABLE '+table+' ADD COLUMN '+name+' '+type);
    }
    this.db.exec("UPDATE sources SET uid='source-'||sequence WHERE uid=''");
    this.db.prepare('INSERT INTO controllers VALUES(?,?,?)').run(this.instance,process.pid,JSON.stringify(ownProcess));
  }
  transaction(fn,readOnly=false){this.db.exec(readOnly?'BEGIN':'BEGIN IMMEDIATE');try{const r=fn();this.db.exec('COMMIT');return r;}catch(e){this.db.exec('ROLLBACK');throw e;}}
  prepare({goal,context='',requestId}){
    bounded(goal,'goal',20000);if(typeof context!=='string'||Buffer.byteLength(context)>500000)throw new Error('Provide bounded project context');bounded(requestId,'requestId',128);
    const old=this.db.prepare('SELECT * FROM workspaces WHERE request_id=?').get(requestId);
    if(old){if(old.goal!==goal||old.context!==context)throw new Error('Request ID was reused with different input');return old.id;}
    return this.transaction(()=>{const id=randomUUID();this.db.prepare('INSERT INTO workspaces VALUES(?,?,?,?,?)').run(id,requestId,goal,context,iso());this.makePacket(id);return id;});
  }
  workspace(id){const row=this.db.prepare('SELECT * FROM workspaces WHERE id=?').get(id);if(!row)throw new Error('Unknown workspace');return row;}
  packet(id){this.workspace(id);let p=this.db.prepare('SELECT * FROM packets WHERE session_id=? ORDER BY revision DESC LIMIT 1').get(id);if(!p){this.makePacket(id);p=this.db.prepare('SELECT * FROM packets WHERE session_id=? ORDER BY revision DESC LIMIT 1').get(id);}return {...p,data:JSON.parse(p.data)};}
  makePacket(id){const w=this.workspace(id),revision=(this.db.prepare('SELECT max(revision) n FROM packets WHERE session_id=?').get(id).n??0)+1;const data={objectiveHash:digest(w.goal),contextHash:digest(w.context),evidence:this.evidence(id).map(e=>({id:e.uid,hash:e.hash,status:e.payload.status,supersedes:e.payload.supersedes??null}))};this.db.prepare('INSERT INTO packets VALUES(?,?,?,?,?)').run(id,revision,JSON.stringify(data),digest(data),iso());return revision;}
  evidence(id){return this.db.prepare('SELECT * FROM evidence WHERE session_id=? ORDER BY sequence').all(id).map(e=>({...e,payload:JSON.parse(e.payload)}));}
  inputSnapshot(id,batchLimit=0){
    this.packet(id); // Complete any legacy packet initialization before the read transaction.
    return this.transaction(()=>{
      const packet=this.packet(id),latest=this.latest(id),feedbackRevision=this.head(id).revision,evidence=this.evidence(id);
      const batch=batchLimit?this.sources(id,latest?.through_source??0,batchLimit):[],through=batch.at(-1)?.sequence??latest?.through_source??0;
      const validSourceIds=batchLimit?this.db.prepare('SELECT uid FROM sources WHERE session_id=? AND sequence<=?').all(id,through).map(s=>s.uid):[];
      return {packet,evidence,latest,feedbackRevision,batch,through,validSourceIds};
    },true);
  }
  submitEvidence(id,{requestId,expectedInputRevision,...payload}){
    this.workspace(id);bounded(requestId,'evidence requestId',128);bounded(payload.text,'evidence text',100000);bounded(payload.provenance,'provenance',4000);bounded(payload.sourceRevision,'source revision',256);
    if(!['observed','reported','hypothesis','stale'].includes(payload.status)||typeof payload.observedAt!=='string'||!Number.isFinite(Date.parse(payload.observedAt)))throw new Error('Evidence needs status and an observation time');
    if(Object.keys(payload).some(k=>!['text','provenance','sourceRevision','observedAt','status','supersedes'].includes(k)))throw new Error('Unknown evidence field');
    const hash=digest(payload);
    return this.transaction(()=>{
      const old=this.db.prepare('SELECT * FROM evidence WHERE session_id=? AND request_id=?').get(id,requestId);
      if(old){if(!isDeepStrictEqual(JSON.parse(old.payload),JSON.parse(JSON.stringify(payload))))throw new Error('Evidence request ID conflicts with an existing payload');return {evidenceId:old.uid,inputRevision:old.input_revision,hash:old.hash,replayed:true};}
      const packet=this.packet(id);if(expectedInputRevision!==packet.revision)throw new Error('Stale input revision; current is '+packet.revision);
      const all=this.evidence(id);if(payload.supersedes&&!all.some(e=>e.uid===payload.supersedes))throw new Error('Unknown superseded evidence');
      if(all.length>=100||all.reduce((n,e)=>n+Buffer.byteLength(JSON.stringify(e.payload)),0)+Buffer.byteLength(JSON.stringify(payload))>250000)throw new Error('Evidence packet capacity reached');
      const uid='evidence-'+randomUUID(),revision=packet.revision+1;
      this.db.prepare('INSERT INTO evidence(session_id,uid,request_id,payload,hash,input_revision,created_at) VALUES(?,?,?,?,?,?,?)').run(id,uid,requestId,JSON.stringify(payload),hash,revision,iso());this.makePacket(id);this.audit(id,'controller','evidence',{evidenceId:uid,inputRevision:revision,hash});return {evidenceId:uid,inputRevision:revision,hash,replayed:false};
    });
  }
  reserve(id,config){this.workspace(id);this.packet(id);const json=JSON.stringify(config);const r=this.db.prepare("INSERT INTO runs(session_id,config,state,owner_pid,detail,owner_token,epoch) VALUES(?,?,'starting',?,'{}',?,1) ON CONFLICT DO NOTHING").run(id,json,process.pid,this.instance);if(JSON.stringify(this.run(id).config)!==json)throw new Error('Workspace already has a different immutable run configuration.');return r.changes===1;}
  run(id){const r=this.db.prepare('SELECT * FROM runs WHERE session_id=?').get(id);return r?{...r,config:JSON.parse(r.config),detail:JSON.parse(r.detail)}:null;}
  claimRecording(id){return this.transaction(()=>{
    const r=this.run(id);if(!r||!terminalStates.includes(r.state))throw new Error('Recording is still owned by an active controller');
    if(r.detail.termination?.status!=='confirmed'){
      const identityState=sameProcess(r.detail.host);
      if(identityState!=='dead')throw new Error('Prior host termination is not confirmed; recording recovery is blocked (identity '+identityState+')');
      r.detail.termination={status:'confirmed',basis:'captured host identity observed dead during explicit recording recovery',checkedAt:iso()};
      this.db.prepare('UPDATE runs SET detail=? WHERE session_id=?').run(JSON.stringify(r.detail),id);
      this.audit(id,'host','termination_rechecked',{host:r.detail.host,termination:r.detail.termination});
    }
    this.db.prepare("UPDATE runs SET owner_pid=?,owner_token=?,epoch=epoch+1,state='recovering' WHERE session_id=?").run(process.pid,this.instance,id);this.db.prepare('DELETE FROM reservations WHERE session_id=?').run(id);return this.run(id);
  });}
  save(id,state,detail,epoch){const r=this.db.prepare('UPDATE runs SET state=?,detail=? WHERE session_id=? AND owner_token=? AND epoch=?').run(state,JSON.stringify(detail),id,this.instance,epoch??this.run(id)?.epoch);if(r.changes!==1)throw new Error('Controller ownership changed');}
  audit(id,role,type,data){this.db.prepare('INSERT INTO audit(session_id,role,type,data,created_at) VALUES(?,?,?,?,?)').run(id,role,type,JSON.stringify(data),iso());}
  reserveSource(id,operationId,epoch,maxPending,maxBytes){
    return this.transaction(()=>{const r=this.run(id);if(r.owner_token!==this.instance||r.epoch!==epoch)throw new Error('Admission ownership changed');const held=this.db.prepare('SELECT coalesce(sum(bytes),0) bytes FROM reservations WHERE session_id=?').get(id);
      // Recorder backlog is durable data, never a thinker-admission semaphore.
      if(this.counts(id).bytes+held.bytes+2097152>67108864)return false;
      this.db.prepare('INSERT INTO reservations VALUES(?,?,?,?,?)').run(id,operationId,epoch,2097152,iso());return true;});
  }
  releaseSource(operationId){this.db.prepare('DELETE FROM reservations WHERE operation_id=?').run(operationId);}
  source(id,s){
    if(Buffer.byteLength(s.text)>2097152)throw new Error('Published output exceeded the 2 MiB per-turn limit');
    const old=this.db.prepare('SELECT * FROM sources WHERE session_id=? AND event_id=?').get(id,s.turnId);if(old){if(old.text!==s.text)throw new Error('Source identity conflict');return old;}
    if(this.counts(id).bytes+Buffer.byteLength(s.text)>67108864)throw new Error('Workspace source limit reached (64 MiB)');
    return this.transaction(()=>{const uid='source-'+randomUUID();this.db.prepare('INSERT INTO sources(session_id,event_id,thinker,round,thread_id,turn_id,model,text,created_at,uid,input_revision,feedback_revision) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,s.turnId,s.thinker,s.round,s.threadId,s.turnId,s.model,s.text,iso(),uid,s.inputRevision??1,s.feedbackRevision??0);if(s.operationId)this.releaseSource(s.operationId);this.audit(id,'thinker','checkpoint',{sourceId:uid,thinker:s.thinker,round:s.round,turnId:s.turnId});return this.db.prepare('SELECT * FROM sources WHERE session_id=? AND uid=?').get(id,uid);});
  }
  sources(id,after=0,limit=100000){return this.db.prepare('SELECT * FROM sources WHERE session_id=? AND sequence>? ORDER BY sequence LIMIT ?').all(id,after,limit);}
  counts(id,after=0){return this.db.prepare('SELECT count(*) n,coalesce(max(sequence),0) head,coalesce(sum(length(CAST(text AS BLOB))),0) bytes,min(created_at) oldest FROM sources WHERE session_id=? AND sequence>?').get(id,after);}
  latest(id){const r=this.db.prepare('SELECT * FROM revisions WHERE session_id=? ORDER BY sequence DESC LIMIT 1').get(id);return r?{...r,feedback:JSON.parse(r.feedback)}:undefined;}
  head(id){return this.db.prepare('SELECT count(*) revision,coalesce(max(sequence),0) sequence FROM revisions WHERE session_id=?').get(id);}
  pending(id){const r=this.db.prepare('SELECT through_source,input_revision FROM revisions WHERE session_id=? ORDER BY sequence DESC LIMIT 1').get(id),c=this.counts(id,r?.through_source??0);return {...c,evidencePending:this.counts(id).n>0&&(r?.input_revision??0)<this.packet(id).revision};}
  recorderStatus(id,recorder={}){const pending=this.pending(id);return {...recorder,status:recorder.status==='current'&&(pending.n||pending.evidencePending)?'pending':recorder.status,pendingSources:pending.n,pendingBytes:pending.bytes,oldestPendingMs:pending.oldest?Math.max(0,Date.now()-Date.parse(pending.oldest)):0,evidencePending:pending.evidencePending};}
  validateFeedback(id,feedback,through,inputRevision){
    if(!feedback||!Array.isArray(feedback.findings)||!Array.isArray(feedback.questions)||!Array.isArray(feedback.nextDirections)||feedback.findings.length>24||feedback.questions.length>16||feedback.nextDirections.length>8||Buffer.byteLength(JSON.stringify(feedback))>32000)throw new Error('Invalid bounded feedback ledger');
    const ids=new Set(),sources=new Set(this.db.prepare('SELECT uid FROM sources WHERE session_id=? AND sequence<=?').all(id,through).map(s=>s.uid)),evidence=new Set(this.evidence(id).filter(e=>e.input_revision<=inputRevision).map(e=>e.uid));
    for(const item of [...feedback.findings,...feedback.questions]){bounded(item.id,'claim ID',128);if(ids.has(item.id))throw new Error('Duplicate feedback ID');ids.add(item.id);bounded(item.summary??item.question,'feedback text',2000);if(!Array.isArray(item.sourceIds)||!Array.isArray(item.evidenceIds)||item.sourceIds.some(s=>!sources.has(s))||item.evidenceIds.some(e=>!evidence.has(e)))throw new Error('Unresolved feedback citation');}
    for(const f of feedback.findings)if(!['new','correction','disagreement','repetition','uncertainty'].includes(f.kind))throw new Error('Invalid finding kind');
    for(const q of feedback.questions){bounded(q.decision,'evidence decision',2000);if(!['open','answered'].includes(q.status))throw new Error('Invalid evidence request status');}
    for(const d of feedback.nextDirections)bounded(d,'next direction',2000);
  }
  record(id,through,markdown,feedback={findings:[],questions:[],nextDirections:[]},inputRevision=this.packet(id).revision,{exportNow=true}={}){
    bounded(markdown,'tracker document',1048576);const last=this.latest(id);
    if((last&&through<last.through_source)||(last&&through===last.through_source&&inputRevision<=last.input_revision)||!this.db.prepare('SELECT 1 FROM sources WHERE session_id=? AND sequence=?').get(id,through))throw new Error('Tracker revision did not advance source/evidence coverage');
    if(inputRevision>this.packet(id).revision||(last&&inputRevision<last.input_revision))throw new Error('Invalid tracker packet revision');
    this.validateFeedback(id,feedback,through,inputRevision);
    const refs=new Set([...this.db.prepare('SELECT uid FROM sources WHERE session_id=? AND sequence<=?').all(id,through).map(s=>s.uid),...this.evidence(id).filter(e=>e.input_revision<=inputRevision).map(e=>e.uid)]);
    for(const match of markdown.matchAll(/\]\(#((?:source|evidence)-[\w-]+)\)/g))if(!refs.has(match[1]))throw new Error('Unresolved Markdown citation');
    this.transaction(()=>{this.db.prepare('INSERT INTO revisions(session_id,through_source,markdown,created_at,input_revision,feedback) VALUES(?,?,?,?,?,?)').run(id,through,markdown,iso(),inputRevision,JSON.stringify(feedback));this.audit(id,'tracker','document',{throughSource:through,inputRevision});});if(exportNow)this.export(id);
  }
  document(id){
    const w=this.workspace(id),sources=this.sources(id),revisions=this.db.prepare('SELECT * FROM revisions WHERE session_id=? ORDER BY sequence').all(id);if(!sources.length&&!revisions.length)return '';
    const notes=new Map();for(const [i,r] of revisions.entries()){const list=notes.get(r.through_source)??[];list.push('### Tracker notes · Revision '+(i+1)+'\n\n'+r.markdown+'\n');notes.set(r.through_source,list);}
    return '# Research notebook\n\n## Objective\n\n'+w.goal+'\n\n## Published research\n\n'+sources.map(s=>'<a id="'+s.uid+'"></a>\n### Thinker '+s.thinker+' · Round '+s.round+'\n\n'+s.model+' · '+s.created_at+'\nThread: '+s.thread_id+' · Turn: '+s.turn_id+'\nInput revision: '+s.input_revision+' · Feedback revision: '+s.feedback_revision+'\n\n'+s.text+'\n\n'+(notes.get(s.sequence)??[]).join('\n')).join('\n')+'\n## Evidence record\n\n'+this.evidence(id).map(e=>'<a id="'+e.uid+'"></a>\n### '+e.uid+'\n\n'+e.payload.status+' · '+e.payload.provenance+' · source revision '+e.payload.sourceRevision+' · '+e.payload.observedAt+'\n\n'+e.payload.text+'\n').join('\n');
  }
  export(id){const dir=path.join(this.directory,id),file=path.join(dir,'research.md'),head=this.head(id);let error=null;try{mkdirSync(dir,{recursive:true});writeFileSync(file+'.tmp',this.document(id));renameSync(file+'.tmp',file);}catch(e){error=e.message;}this.db.prepare('INSERT INTO exports VALUES(?,?,?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET source_head=excluded.source_head,revision_head=excluded.revision_head,input_revision=excluded.input_revision,path=excluded.path,error=excluded.error,updated_at=excluded.updated_at').run(id,this.counts(id).head,head.sequence,this.packet(id).revision,file,error,iso());return {path:file,error};}
  sourcePage(id,after=0,limit=5){this.workspace(id);const rows=this.sources(id,after,pageSize(limit)+1);return {items:rows.slice(0,pageSize(limit)),hasMore:rows.length>pageSize(limit),nextCursor:rows.slice(0,pageSize(limit)).at(-1)?.sequence??after};}
  revisionPage(id,after=0,limit=5){this.workspace(id);const rows=this.db.prepare('SELECT * FROM revisions WHERE session_id=? AND sequence>? ORDER BY sequence LIMIT ?').all(id,after,pageSize(limit)+1).map(r=>({...r,feedback:JSON.parse(r.feedback)}));return {items:rows.slice(0,pageSize(limit)),hasMore:rows.length>pageSize(limit),nextCursor:rows.slice(0,pageSize(limit)).at(-1)?.sequence??after};}
  content(id){this.workspace(id);const r=this.latest(id);return {revision:this.head(id).revision,markdown:this.document(id),feedback:r?.feedback??null,inputRevision:r?.input_revision??0,throughSource:r?.through_source??0,evidence:this.evidence(id)};}
  snapshot(id,{includeDocument=false,includeDrafts=false}={}){
    const w=this.workspace(id),r=this.run(id),count=this.counts(id),rev=this.db.prepare('SELECT sequence,through_source,input_revision FROM revisions WHERE session_id=? ORDER BY sequence DESC LIMIT 1').get(id),head=this.head(id),packet=this.packet(id);
    const events=this.db.prepare('SELECT sequence,role,type,created_at FROM audit WHERE session_id=? ORDER BY sequence DESC LIMIT 8').all(id).reverse(),exp=this.db.prepare('SELECT * FROM exports WHERE session_id=?').get(id);
    const detail={...r?.detail};if(!includeDrafts)delete detail.drafts;if(detail.receipts){detail.receiptCount=detail.receipts.length;detail.receipts=detail.receipts.slice(-8);}if(detail.archivedRun)delete detail.archivedRun;
    if(r)detail.recorder=this.recorderStatus(id,detail.recorder);
    if(r)detail.controllerInstance=r.owner_token;
    return {id,goal:w.goal,revision:head.revision,contentVersion:head.sequence+':'+packet.revision+':'+count.head,inputRevision:packet.revision,eventCount:this.db.prepare('SELECT count(*) n FROM audit WHERE session_id=?').get(id).n,events,state:r?.state??'ready',export:{...exp,fresh:Boolean(exp&&!exp.error&&exp.source_head===count.head&&exp.revision_head===head.sequence&&exp.input_revision===packet.revision)},run:r?{...detail,config:r.config,state:r.state,ownerPid:r.owner_pid,epoch:r.epoch,sourceCount:count.n,sourceBytes:count.bytes,recordedThrough:rev?.through_source??0,recordedCount:this.db.prepare('SELECT count(*) n FROM sources WHERE session_id=? AND sequence<=?').get(id,rev?.through_source??0).n,recordedInputRevision:rev?.input_revision??0}:null,launchRequest:null,...(includeDocument?{document:this.document(id)}:{})};
  }
  recover(){for(const r of this.db.prepare('SELECT * FROM runs').all()){
    if(terminalStates.includes(r.state)||(r.owner_token===this.instance&&r.owner_pid===process.pid))continue;
    const owner=this.db.prepare('SELECT * FROM controllers WHERE instance=?').get(r.owner_token);let state;
    if(owner)state=sameProcess({...JSON.parse(owner.identity),pid:r.owner_pid});else{try{process.kill(r.owner_pid,0);state='unknown';}catch{state='dead';}}
    if(state==='dead'){const detail=JSON.parse(r.detail),hostState=sameProcess(detail.host);detail.termination={status:hostState==='dead'?'confirmed':'unknown',basis:'controller identity lost; host identity checked'};detail.error='Previous controller exited. No thinker was relaunched.';detail.recoveredAt=iso();this.db.prepare("UPDATE runs SET state='interrupted',detail=? WHERE session_id=?").run(JSON.stringify(detail),r.session_id);}
  }}
  package(id){
    this.packet(id);
    const payload=this.transaction(()=>({schemaVersion:1,workspace:this.workspace(id),run:this.run(id),sources:this.sources(id),revisions:this.db.prepare('SELECT * FROM revisions WHERE session_id=? ORDER BY sequence').all(id),evidence:this.db.prepare('SELECT * FROM evidence WHERE session_id=? ORDER BY sequence').all(id),packets:this.db.prepare('SELECT * FROM packets WHERE session_id=? ORDER BY revision').all(id),audit:this.db.prepare('SELECT * FROM audit WHERE session_id=? ORDER BY sequence').all(id),markdown:this.document(id)}));
    const manifest=Object.fromEntries(Object.entries(payload).map(([k,v])=>[k,digest(v)])),bundle={format:'goal-loop-research-package-v1',manifest,payload},dir=path.join(this.directory,id);Store.verifyPackage(bundle);mkdirSync(dir,{recursive:true});const file=path.join(dir,'research.goal-loop.json');writeFileSync(file+'.tmp',JSON.stringify(bundle,null,2));renameSync(file+'.tmp',file);return {path:file,hash:digest(bundle),sourceCount:payload.sources.length,revisionCount:payload.revisions.length};
  }
  static verifyPackage(bundle){
    if(bundle?.format!=='goal-loop-research-package-v1'||!bundle.payload||bundle.payload.schemaVersion!==1)throw new Error('Unsupported research package');
    for(const [k,v] of Object.entries(bundle.payload))if(bundle.manifest?.[k]!==digest(v))throw new Error('Package hash mismatch: '+k);
    const p=bundle.payload,sourceIds=new Set(p.sources.map(s=>s.uid)),evidenceIds=new Set(p.evidence.map(e=>e.uid));if(sourceIds.size!==p.sources.length||evidenceIds.size!==p.evidence.length)throw new Error('Duplicate package identities');
    for(const e of p.evidence)if(digest(JSON.parse(e.payload))!==e.hash)throw new Error('Evidence hash mismatch');
    for(const packet of p.packets)if(digest(JSON.parse(packet.data))!==packet.hash)throw new Error('Packet hash mismatch');
    for(const r of p.revisions){if(!p.sources.some(s=>s.sequence===r.through_source)||!p.packets.some(x=>x.revision===r.input_revision))throw new Error('Unresolved package coverage');const f=JSON.parse(r.feedback);for(const item of [...(f.findings??[]),...(f.questions??[])])if(item.sourceIds.some(x=>!sourceIds.has(x))||item.evidenceIds.some(x=>!evidenceIds.has(x)))throw new Error('Unresolved package citation');}
    return {valid:true,hash:digest(bundle),sources:p.sources.length,revisions:p.revisions.length};
  }
  restore(bundle,requestId){
    const verified=Store.verifyPackage(bundle);bounded(requestId,'restore requestId',128);const old=this.db.prepare('SELECT * FROM workspaces WHERE request_id=?').get(requestId);if(old){if(this.run(old.id)?.detail?.packageHash!==verified.hash)throw new Error('Restore request ID conflict');return {id:old.id,replayed:true,...verified};}
    const id=randomUUID(),p=bundle.payload;
    this.transaction(()=>{
      this.db.prepare('INSERT INTO workspaces VALUES(?,?,?,?,?)').run(id,requestId,p.workspace.goal,p.workspace.context,iso());
      for(const packet of p.packets)this.db.prepare('INSERT INTO packets VALUES(?,?,?,?,?)').run(id,packet.revision,packet.data,packet.hash,packet.created_at);
      for(const e of p.evidence)this.db.prepare('INSERT INTO evidence(session_id,uid,request_id,payload,hash,input_revision,created_at) VALUES(?,?,?,?,?,?,?)').run(id,e.uid,e.request_id,e.payload,e.hash,e.input_revision,e.created_at);
      const map=new Map();for(const s of p.sources){const r=this.db.prepare('INSERT INTO sources(session_id,event_id,thinker,round,thread_id,turn_id,model,text,created_at,uid,input_revision,feedback_revision) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,s.event_id,s.thinker,s.round,s.thread_id,s.turn_id,s.model,s.text,s.created_at,s.uid,s.input_revision,s.feedback_revision);map.set(s.sequence,Number(r.lastInsertRowid));}
      for(const r of p.revisions)this.db.prepare('INSERT INTO revisions(session_id,through_source,markdown,created_at,input_revision,feedback) VALUES(?,?,?,?,?,?)').run(id,map.get(r.through_source),r.markdown,r.created_at,r.input_revision,r.feedback);
      for(const a of p.audit)this.db.prepare('INSERT INTO audit(session_id,role,type,data,created_at) VALUES(?,?,?,?,?)').run(id,a.role,a.type,a.data,a.created_at);
      this.db.prepare("INSERT INTO runs(session_id,config,state,owner_pid,detail,owner_token,epoch) VALUES(?,?,'restored',?,?,?,1)").run(id,JSON.stringify(p.run?.config??{}),process.pid,JSON.stringify({originalSessionId:p.workspace.id,packageHash:verified.hash,archivedRun:p.run?.detail,termination:{status:'confirmed',basis:'offline restoration; no inference admitted'}}),this.instance);this.audit(id,'controller','restored',{packageHash:verified.hash});
    });this.export(id);return {id,replayed:false,...verified};
  }
  close(){this.db.close();}
}

// Local data lives in the user's home folder unless --data or GOAL_LOOP_DATA says otherwise.
export function defaultDataDir(){return joinPath(homedir(),'.adhd','data');}
