import path from 'node:path';
const schema=(description,properties,required)=>({description,inputSchema:{type:'object',properties,required,additionalProperties:false}});
const sessionId={type:'string'},text={type:'string'};
export const schemas={
  goal_loop_start:schema('Start uninterrupted native research with an independent asynchronous tracker (Terra by default, Sonnet 5.5 for Claude-only runs; set configuration.tracker to choose) and a lossless document. Defaults to continuous until user pause/stop; configuration.continuous=true explicitly selects it. Round/time limits are opt-in. Use exact catalog model/max/tier; never pause for tracker/evidence/tools. Retain requestId for retries.',{requestId:text,goal:text,context:text,configuration:{type:'object'}},['requestId','goal']),
  goal_loop_status:schema('Read genuinely compact research, recorder, termination and export state. Full notebook is opt-in.',{sessionId,includeDocument:{type:'boolean'}},['sessionId']),
  goal_loop_control:schema('Pause after active rounds, resume, stop now, recover recording from saved sources without restarting thinkers, or repair the Markdown export. Recovery may explicitly raise trackerContextBytes (up to 8 MiB).',{sessionId,action:{type:'string',enum:['pause','resume','stop','recover_recording','repair_export']},trackerContextBytes:{type:'integer'}},['sessionId','action']),
  goal_loop_catalog:schema('Read the models the installed hosts offer (Codex app-server and Claude Code); no inference.',{},[]),
  goal_loop_evidence:schema('Submit attributed evidence or corrections. They reach the next eligible thinker round without waiting for recording. Retain requestId; changed payload conflicts. Use current input revision.',{sessionId,requestId:text,expectedInputRevision:{type:'integer'},text,provenance:text,sourceRevision:text,observedAt:text,status:{type:'string',enum:['observed','reported','hypothesis','stale']},supersedes:text},['sessionId','requestId','expectedInputRevision','text','provenance','sourceRevision','observedAt','status']),
  goal_loop_read:schema('Read the lossless document plus current feedback, paged verbatim source rounds or additive organization revisions. Every published source appears in the document before the tracker responds; nothing is selected for omission.',{sessionId,view:{type:'string',enum:['synthesis','sources','revisions','inputs']},after:{type:'integer'},limit:{type:'integer'}},['sessionId','view']),
  goal_loop_export:schema('Save a consistent hash-manifested research package containing inputs, source archive, revision history and receipts. No inference.',{sessionId},['sessionId'])
};
export function toolService(runtime,web){
  let catalog;
  return async(name,a={})=>{
    let value;const store=runtime.store;
    switch(name){
      case 'goal_loop_start':{const id=store.prepare(a);value=runtime.start(id,a.configuration);break;}
      case 'goal_loop_status':value=runtime.status(a.sessionId,{includeDocument:a.includeDocument});break;
      case 'goal_loop_control':value=await runtime.control(a.sessionId,a.action,{trackerContextBytes:a.trackerContextBytes});break;
      case 'goal_loop_catalog':catalog??=runtime.catalog().catch(e=>{catalog=null;throw e;});value=await catalog;break;
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
