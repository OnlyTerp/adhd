import path from 'node:path';
const schema=(description,properties,required)=>({description,inputSchema:{type:'object',properties,required,additionalProperties:false}});
const sessionId={type:'string'},text={type:'string'};
export const schemas={
  goal_loop_start:schema('Start tool-free research: 1–4 thinker models work on the goal round after round while an independent tracker organizes their published results into a lossless live document (open the returned url). configuration.thinkers and configuration.tracker are selections {backend, modelId, speedId, reasoning} copied from goal_loop_catalog; any backend and model can think or track. Omitted thinkers: the best installed model is chosen. Omitted tracker: Terra with a Codex thinker, Sonnet at medium effort with a Claude thinker, else the thinker\'s own model. Runs are continuous until pause/stop unless maxRounds/maxMinutes are set. At maxMinutes thinkers stop at once; the tracker may keep recording published rounds for up to 15 more minutes (state draining). Plan limits are guarded: a run never spends purchased credits or Claude extra usage unless allowCredits is true, and a per-token endpoint needs maxTokens. Supply the facts the thinkers need in context; they cannot use tools. Retain requestId for retries.',{requestId:text,goal:text,context:text,configuration:{type:'object'}},['requestId','goal']),
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
      case 'goal_loop_start':{const configuration=a.configuration?.thinkers?a.configuration:{...a.configuration,thinkers:[defaultThinker(await readCatalog())]};const id=store.prepare(a);value=runtime.start(id,configuration);break;}
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
