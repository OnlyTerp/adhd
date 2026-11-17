import path from 'node:path';
import {readFileSync,statSync} from 'node:fs';
// goal/context may come from files so a large seed fits one tool call. Files are read here, before the
// store sees the request, so a retry with the same requestId and unchanged files is still idempotent.
const SEED_LIMITS={goal:20000,context:500000};
export function readSeed(a){
  const seed={requestId:a.requestId,goal:a.goal,context:a.context};
  for(const field of ['goal','context']){
    const file=a[field+'File'];if(file===undefined)continue;const name=field+'File';
    if(a[field]!==undefined)throw new Error('Pass '+field+' or '+name+', not both.');
    if(typeof file!=='string'||!path.isAbsolute(file))throw new Error(name+' must be an absolute path.');
    let size;try{size=statSync(file).size;}catch(e){throw new Error(name+' could not be read ('+(e.code??e.message)+').');}
    if(size>SEED_LIMITS[field]+3)throw new Error(name+' is '+size+' bytes; the limit is '+SEED_LIMITS[field]+'.');
    let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(readFileSync(file));}catch(e){throw new Error(name+' is not valid UTF-8 text.');}
    if(text.charCodeAt(0)===0xFEFF)text=text.slice(1);
    if(Buffer.byteLength(text)>SEED_LIMITS[field])throw new Error(name+' is '+Buffer.byteLength(text)+' bytes; the limit is '+SEED_LIMITS[field]+'.');
    seed[field]=text;
  }
  if(typeof seed.goal!=='string'||!seed.goal.trim())throw new Error('Provide goal or goalFile.');
  if(seed.context===undefined)delete seed.context;
  return seed;
}
const schema=(description,properties,required)=>({description,inputSchema:{type:'object',properties,required,additionalProperties:false}});
const sessionId={type:'string'},text={type:'string'};
export const schemas={
  goal_loop_start:schema('Start tool-free research: 1–4 thinker models work on the goal round after round while an independent tracker organizes their published results into a lossless live document (open the returned url). configuration.thinkers and configuration.tracker are selections {backend, modelId, speedId, reasoning} copied from goal_loop_catalog; any backend and model can think or track. Omitted thinkers: the best installed model is chosen. Omitted tracker: Terra with a Codex thinker, Sonnet at medium effort with a Claude thinker, else the thinker\'s own model. Runs are continuous until pause/stop unless maxRounds/maxMinutes are set. At maxMinutes thinkers stop at once; the tracker may keep recording published rounds for up to 15 more minutes (state draining). Plan limits are guarded: a run never spends purchased credits or Claude extra usage unless allowCredits is true, and a per-token endpoint needs maxTokens. Supply the facts the thinkers need in context; they cannot use tools. A large goal or context can be passed as goalFile/contextFile (absolute path to a UTF-8 file) instead of inline text. Retain requestId for retries.',{requestId:text,goal:{type:'string',description:'The objective (at most 20,000 bytes). Give goal or goalFile.'},goalFile:{type:'string',description:'Absolute path to a UTF-8 file holding the goal, instead of goal.'},context:{type:'string',description:'Facts, excerpts, constraints and unknowns the thinkers need (at most 500,000 bytes).'},contextFile:{type:'string',description:'Absolute path to a UTF-8 file holding the context, instead of context. Use it for large seeds.'},configuration:{type:'object',description:'Run settings. For a bounded run set both maxRounds and maxMinutes: setting only one defaults the other to 12 rounds or 30 minutes. Omit both (or set continuous) for a continuous run.',properties:{thinkers:{type:'array',items:{type:'object'},description:'1–4 selections {backend, modelId, speedId, reasoning} from goal_loop_catalog.'},tracker:{type:'object',description:'One selection from goal_loop_catalog.'},continuous:{type:'boolean'},maxRounds:{type:'integer',description:'Round cap per thinker, 1–10000.'},maxMinutes:{type:'number',description:'Wall-clock limit, 0.1–1440.'},maxUsagePercent:{type:'integer',description:'Codex plan percentage at which a continuous run pauses (default 90).'},allowCredits:{type:'boolean',description:'Allow purchased credits or Claude extra usage (default false).'},maxTokens:{type:'integer',description:'Cap on the run\'s input plus output tokens; required for per-token endpoints.'},feedbackEnabled:{type:'boolean'},trackerContextBytes:{type:'integer'},maxPending:{type:'integer'},maxPendingBytes:{type:'integer'},recorderRetries:{type:'integer'}}}},['requestId']),
  goal_loop_status:schema('Read genuinely compact research, recorder, termination and export state. Full notebook is opt-in.',{sessionId,includeDocument:{type:'boolean'}},['sessionId']),
  goal_loop_control:schema('Pause after active rounds, resume, stop now, recover recording from saved sources without restarting thinkers, or repair the Markdown export. Recovery may explicitly raise trackerContextBytes (up to 8 MiB).',{sessionId,action:{type:'string',enum:['pause','resume','stop','recover_recording','repair_export']},trackerContextBytes:{type:'integer'}},['sessionId','action']),
  goal_loop_catalog:schema('List the installed research backends (Codex, Claude Code, ACP agents such as Devin, configured OpenAI-compatible endpoints), their honest capabilities (tool-free proof, usage meter, billing) and every model with its efforts and speeds. Unavailable backends are listed with the reason. No inference.',{},[]),
  goal_loop_evidence:schema('Submit attributed evidence or corrections. They reach the next eligible thinker round without waiting for recording. Retain requestId; changed payload conflicts. Use current input revision. Put several related measurements in one item rather than many small ones: every item is also re-read by the tracker.',{sessionId,requestId:{type:'string',description:'Retry key; reuse it with the identical payload on retry.'},expectedInputRevision:{type:'integer',description:'inputRevision from goal_loop_status.'},text:{type:'string',description:'The measurement, result or correction itself.'},provenance:{type:'string',description:'How it was obtained: command, tool, file or person.'},sourceRevision:{type:'string',description:'The commit, version or build it was measured on.'},observedAt:{type:'string',description:'ISO time it was observed; take it from the real clock.'},status:{type:'string',enum:['observed','reported','hypothesis','stale'],description:'observed = you measured it; reported = someone else did; hypothesis = unverified; stale = no longer current.'},supersedes:{type:'string',description:'Optional evidence ID this corrects.'}},['sessionId','requestId','expectedInputRevision','text','provenance','sourceRevision','observedAt','status']),
  goal_loop_read:schema('Read the lossless document plus current feedback, paged verbatim source rounds or additive organization revisions. Every published source appears in the document before the tracker responds; nothing is selected for omission.',{sessionId,view:{type:'string',enum:['synthesis','sources','revisions','inputs']},after:{type:'integer'},limit:{type:'integer'}},['sessionId','view']),
  goal_loop_export:schema('Save a consistent hash-manifested research package containing inputs, source archive, revision history and receipts. No inference.',{sessionId},['sessionId'])
};
// Thinkers the caller did not choose: the strongest model actually installed.
const PREFERRED=[['codex','gpt-6-astra','priority','max'],['claude','claude-opus-5-5','standard','max']];
// A backend whose plan is spent or nearly spent (default continuous pause point) is skipped.
export function defaultThinker(cat){
  const spent=new Set((cat?.backends??[]).filter(b=>b.usage&&(b.usage.exhausted||b.usage.usedPercent>=90)).map(b=>b.id));
  const models=(cat?.models??[]).filter(m=>!spent.has(m.backend));
  for(const [backend,modelId,speedId,reasoning] of PREFERRED){const m=models.find(x=>x.backend===backend&&x.id===modelId);if(m&&m.speeds?.some(s=>s.id===speedId))return {backend,modelId,speedId,reasoning};}
  const m=models[0];if(!m&&spent.size)throw new Error('Every installed backend is at its plan limit: '+[...spent].join(', ')+'. Read goal_loop_catalog.');if(!m)throw new Error('No research model is installed. Read goal_loop_catalog for what each backend needs.');
  return {backend:m.backend,modelId:m.id,speedId:m.speeds?.[0]?.id??'standard',reasoning:m.efforts?.includes('max')?'max':m.efforts?.[0]??'default'};
}
export function toolService(runtime,web){
  // Cached briefly: sign-ins, endpoint edits and plan usage change while the server runs.
  let catalog,at=0;const readCatalog=()=>{if(!catalog||Date.now()-at>60000){at=Date.now();catalog=runtime.catalog().catch(e=>{catalog=null;throw e;});}return catalog;};
  return async(name,a={})=>{
    let value;const store=runtime.store;
    switch(name){
      case 'goal_loop_start':{const seed=readSeed(a);const configuration=a.configuration?.thinkers?a.configuration:{...a.configuration,thinkers:[defaultThinker(await readCatalog())]};const id=store.prepare(seed);value=runtime.start(id,configuration);break;}
      case 'goal_loop_status':value=runtime.status(a.sessionId,{includeDocument:a.includeDocument});break;
      case 'goal_loop_control':value=await runtime.control(a.sessionId,a.action,{trackerContextBytes:a.trackerContextBytes});break;
      case 'goal_loop_catalog':value=await readCatalog();break;
      case 'goal_loop_evidence':{const {sessionId,...input}=a;value=runtime.evidence(sessionId,input);break;}
      case 'goal_loop_read':
        if(a.view==='synthesis')value=store.content(a.sessionId);
        else if(a.view==='sources')value=store.sourcePage(a.sessionId,a.after,a.limit);
        else if(a.view==='revisions')value=store.revisionPage(a.sessionId,a.after,a.limit);
        else if(a.view==='inputs'){const {packet,evidence}=store.inputSnapshot(a.sessionId);value={packet,evidence};}
        else throw new Error('Unknown read view');break;
      case 'goal_loop_export':value=store.package(a.sessionId);break;
      default:throw new Error('Unknown tool');
    }
    if(value.id){value.url=web.url(value.id);value.documentPath=path.join(store.directory,value.id,'research.md');}
    return value;
  };
}
