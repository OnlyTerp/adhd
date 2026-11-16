import {spawn, spawnSync} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {StringDecoder} from 'node:string_decoder';
import {existsSync} from 'node:fs';
import {dirname, join} from 'node:path';

// Codex Desktop's bundled CLI is preferred (it matches the signed-in app); otherwise the
// codex CLI on PATH. Returns [executable, ...leading args].
export function discoverCodex() {
  if (process.env.GOAL_LOOP_CODEX_EXE) return [process.env.GOAL_LOOP_CODEX_EXE];
  if (process.platform !== 'win32') return ['codex'];
  const script = "$parents=@(Get-CimInstance Win32_Process -Filter \"name='ChatGPT.exe'\" | ForEach-Object { $_.ProcessId }); Get-CimInstance Win32_Process -Filter \"name='codex.exe'\" | Where-Object { $parents -contains $_.ParentProcessId -and $_.ExecutablePath } | Select-Object -First 1 -ExpandProperty ExecutablePath";
  const result = spawnSync('powershell.exe', ['-NoProfile','-NonInteractive','-Command',script], {encoding:'utf8', timeout:6000, windowsHide:true});
  const exe = result.stdout?.trim();
  if (exe && existsSync(exe)) return [exe];
  const found = spawnSync('where.exe', ['codex'], {encoding: 'utf8', windowsHide: true, timeout: 4000});
  for (const line of (found.stdout || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean)) {
    if (/\.exe$/i.test(line) && existsSync(line)) return [line];
    if (/\.cmd$/i.test(line)) { const js = join(dirname(line), 'node_modules', '@openai', 'codex', 'bin', 'codex.js'); if (existsSync(js)) return [process.execPath, js]; }
  }
  throw new Error('Install the Codex CLI (or open Codex Desktop), or set GOAL_LOOP_CODEX_EXE to its codex executable.');
}

export const CODEX_CAPABILITIES = {toolFree: 'attested', usageMeter: 'plan', billing: 'subscription', structuredOutput: 'native', compaction: 'reported'};
const efforts = m => (m.supportedReasoningEfforts ?? []).map(e => e.reasoningEffort);

export class CodexClient extends EventEmitter {
  constructor({exe, cwd, requestTimeout=20000}={}) {
    const [bin, ...lead] = exe ? [exe] : discoverCodex();
    super(); this.pending=new Map(); this.seq=0; this.closed=false; this.requestTimeout=requestTimeout;
    // notify=[]: the user's desktop notify hook must not fire after every research round.
    this.proc=spawn(bin,[...lead,'-c','notify=[]','app-server','--stdio'],{cwd, shell:false, windowsHide:true, stdio:['pipe','pipe','pipe']});
    this.exe=bin; this.stderr=''; this.buffer=''; const decoder=new StringDecoder('utf8');
    this.proc.stderr.on('data', chunk=>{this.stderr=(this.stderr+chunk.toString()).slice(-4000);});
    this.proc.stdin.on('error',()=>{});
    this.proc.stdout.on('data', chunk=>{
      this.buffer+=decoder.write(chunk);
      if(Buffer.byteLength(this.buffer)>8*1024*1024) return this.fail(new Error('Host frame limit exceeded'));
      for(let end;(end=this.buffer.indexOf('\n'))>=0;) {
        const line=this.buffer.slice(0,end); this.buffer=this.buffer.slice(end+1);
        if(!line.trim())continue;
        let msg;try{msg=JSON.parse(line);}catch{return this.fail(new Error('Malformed host frame'));}
        if(msg.id!==undefined && !msg.method) {
          const p=this.pending.get(msg.id); if(!p)continue;
          this.pending.delete(msg.id); clearTimeout(p.timer);
          msg.error?p.reject(new Error(msg.error.message||'Host request rejected')):p.resolve(msg.result);
        } else if(msg.id!==undefined) {
          this.send(msg.method?.includes('requestApproval')?{id:msg.id,result:{decision:'decline'}}:{id:msg.id,error:{code:-32601,message:'Research workers cannot call host tools'}});
          this.emit('forbiddenRequest',{method:msg.method,threadId:msg.params?.threadId});
        } else this.emit('notification',msg);
      }
    });
    this.proc.once('error',e=>this.fail(e));
    this.proc.once('close',(code,signal)=>this.fail(new Error(`Codex host disconnected (${code??signal})`)));
  }
  send(msg){if(this.closed)throw new Error('Codex host is disconnected');this.proc.stdin.write(JSON.stringify(msg)+'\n');}
  request(method,params={}, {timeoutMs=this.requestTimeout}={}) {
    if(this.closed)return Promise.reject(new Error('Codex host is disconnected'));
    return new Promise((resolve,reject)=>{
      const id=++this.seq, timer=setTimeout(()=>{this.pending.delete(id);const e=new Error(`${method} timed out; outcome may be unknown`);e.uncertain=true;reject(e);},timeoutMs);
      this.pending.set(id,{resolve,reject,timer});try{this.send({id,method,params});}catch(e){clearTimeout(timer);this.pending.delete(id);reject(e);}
    });
  }
  fail(error){
    if(this.closed)return;this.closed=true;
    error.code=this.closing?'HOST_CLOSED':'HOST_DISCONNECTED';
    for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(error);}this.pending.clear();
    this.emit('disconnect',error);
  }
  async initialize(){
    await this.request('initialize',{clientInfo:{name:'goal-loop-studio',version:'0.2.0'},capabilities:{experimentalApi:true}});
    this.send({method:'initialized',params:{}});
    const account=await this.request('account/read',{refreshToken:false});
    if(account.account?.type!=='chatgpt')throw new Error('Existing ChatGPT login required; API-key and alternate billing routes are not used.');
    this.account={type:account.account.type,planType:account.account.planType};
    this.models=[];let cursor;
    do {const page=await this.request('model/list',{limit:100,includeHidden:false,...(cursor?{cursor}:{})});this.models.push(...page.data);cursor=page.nextCursor;} while(cursor&&this.models.length<1000);
    const config=await this.request('config/read',{includeLayers:false});
    this.restrictions={'web_search':'disabled','model_reasoning_effort':'max'};
    for(const f of ['shell_tool','unified_exec','multi_agent','apps','plugins','browser_use','computer_use','image_generation'])this.restrictions[`features.${f}`]=false;
    for(const name of Object.keys(config.config?.mcp_servers??{}))this.restrictions[`mcp_servers.${name}.enabled`]=false;
    return this;
  }
  validate(selection){
    const m=this.models.find(m=>m.model===selection.modelId);
    if(!m)throw new Error(`Codex model is unavailable: ${selection.modelId}`);
    if(!efforts(m).includes(selection.reasoning))throw new Error(`Effort ${selection.reasoning} is unavailable for ${selection.modelId}; offered: ${efforts(m).join(', ')}`);
    if(!m.serviceTiers?.some(t=>t.id===selection.speedId))throw new Error(`Requested service tier is unavailable for ${selection.modelId}: ${selection.speedId}`);
    return selection;
  }
  catalog(){return {verified:true,source:'Installed Codex app-server model/list',maxThinkers:4,account:this.account,capabilities:CODEX_CAPABILITIES,models:this.models.filter(m=>efforts(m).length&&m.serviceTiers?.length).map(m=>({id:m.model,label:m.displayName||m.model,efforts:efforts(m),...(efforts(m).includes('max')?{maximumReasoning:{value:'max'}}:{}),independentSpeed:true,speeds:m.serviceTiers.map(t=>({id:t.id,label:t.name}))}))};}
  async thread(selection,instructions,cwd){
    this.validate(selection);
    const receipt=await this.request('thread/start',{model:selection.modelId,modelProvider:'openai',allowProviderModelFallback:false,serviceTier:selection.speedId,cwd,environments:[],dynamicTools:[],selectedCapabilityRoots:[],sandbox:'read-only',approvalPolicy:'never',config:{...this.restrictions,model_reasoning_effort:selection.reasoning},developerInstructions:instructions,ephemeral:true});
    if(receipt.model!==selection.modelId||receipt.modelProvider!=='openai'||receipt.serviceTier!==selection.speedId||receipt.reasoningEffort!==selection.reasoning)throw new Error('Host did not admit the exact requested model, provider, tier and effort. No inference started.');
    return {threadId:receipt.thread.id,model:receipt.model,modelProvider:receipt.modelProvider,serviceTier:receipt.serviceTier,reasoningEffort:receipt.reasoningEffort,environmentAccess:false};
  }
  async close(){
    if(this.closePromise)return this.closePromise;
    this.closing=true;
    this.closePromise=new Promise(resolve=>{
      if(this.proc.exitCode!==null||this.proc.signalCode!==null){resolve({confirmed:true});return;}
      let force,deadline;const finish=confirmed=>{clearTimeout(force);clearTimeout(deadline);this.proc.removeListener('close',exited);resolve({confirmed});};
      const exited=()=>finish(true);this.proc.once('close',exited);
      this.proc.stdin.end();
      force=setTimeout(()=>{
        if(process.platform==='win32'){
          const killer=spawn('taskkill.exe',['/PID',String(this.proc.pid),'/T','/F'],{windowsHide:true,stdio:'ignore',timeout:4000});killer.on('error',()=>{});
        }else this.proc.kill('SIGKILL');
      },1000);
      deadline=setTimeout(()=>finish(false),6500);
    });
    return this.closePromise;
  }
}
