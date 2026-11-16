// Only a verified execution adapter may supply this catalog. MCP document
// connectivity does not establish model, speed, effort, or spawn controls.
export function capabilities(raw) {
  const off={available:false,maxThinkers:1,models:[],reason:'This host has not verified thinker configuration.'};
  if(raw?.verified!==true||typeof raw.source!=='string'||!raw.source.trim()||!Number.isSafeInteger(raw.maxThinkers)||raw.maxThinkers<1||raw.maxThinkers>64)return off;
  const seen=new Set(),models=[];
  for(const m of Array.isArray(raw.models)?raw.models:[]){
    if(typeof m?.id!=='string'||!m.id||seen.has(m.id)||typeof m.label!=='string'||typeof m.maximumReasoning?.value!=='string'||!m.maximumReasoning.value)continue;
    // A host may only offer inherited speed. Never relabel it as per-agent choice.
    const speeds=(Array.isArray(m.speeds)?m.speeds:[]).filter(s=>typeof s?.id==='string'&&s.id&&typeof s.label==='string');
    if(!speeds.length)continue; seen.add(m.id);
    models.push({id:m.id,label:m.label,maximumReasoning:{value:m.maximumReasoning.value},speeds,independentSpeed:m.independentSpeed===true});
  }
  return models.length?{available:true,source:raw.source,maxThinkers:raw.maxThinkers,models}:{...off,reason:'No verified model supports maximum reasoning.'};
}
export function initial(raw){const c=capabilities(raw);if(!c.available)return {thinkers:[]};const m=c.models[0];return {thinkers:[{modelId:m.id,speedId:m.speeds[0].id,reasoning:m.maximumReasoning.value}]};}
export function validate(state,raw){const c=capabilities(raw);if(!c.available)return {ok:false,error:c.reason};if(!Array.isArray(state?.thinkers)||!state.thinkers.length||state.thinkers.length>c.maxThinkers)return {ok:false,error:'Unsupported thinker count'};const thinkers=[];for(const t of state.thinkers){const m=c.models.find(m=>m.id===t.modelId);if(!m||t.reasoning!==m.maximumReasoning.value||!m.speeds.some(s=>s.id===t.speedId)||(!m.independentSpeed&&t.speedId!==m.speeds[0].id))return {ok:false,error:'Requested settings are unsupported. Maximum reasoning is required.'};thinkers.push({...t});}return {ok:true,thinkers,source:c.source};}
export function resize(state,count,raw){const c=capabilities(raw);if(!c.available||!Number.isSafeInteger(count)||count<1||count>c.maxThinkers)throw Error('Unsupported thinker count');const base=initial(raw).thinkers[0],next={thinkers:Array.from({length:count},(_,i)=>({...state.thinkers[i]||base}))};if(!validate(next,raw).ok)throw Error('Invalid configuration');return next;}
export function selectModel(state,index,id,raw){const c=capabilities(raw),m=c.models.find(m=>m.id===id);if(!m||!state.thinkers[index])throw Error('Unsupported model');const next={thinkers:state.thinkers.map(t=>({...t}))};next.thinkers[index]={modelId:id,speedId:m.speeds[0].id,reasoning:m.maximumReasoning.value};return next;}
export function mount(container,raw,onChange=()=>{}){
  let state=initial(raw),locked=false,expanded=false;const d=container.ownerDocument;
  function el(tag,text){const n=d.createElement(tag);if(text)n.textContent=text;return n;}
  function draw(){const focusLabel=container.contains?.(d.activeElement)?d.activeElement?.getAttribute?.('aria-label'):null;let restoreTarget=null;const c=capabilities(raw);container.replaceChildren();const details=el('details'),summary=el('summary',c.available?`${state.thinkers.length} thinker${state.thinkers.length===1?'':'s'} · Maximum reasoning`:'1 thinker · Configuration unavailable');details.className='thinker-settings';details.open=expanded;details.ontoggle=()=>{expanded=details.open;};details.append(summary);container.append(details);summary.setAttribute('aria-label','Thinker settings');const body=el('div');body.className='thinker-settings-body';details.append(body);body.append(el('p','The thinker explores. The tracker documents. Reasoning is always maximum.'));
    function select(label,options,value,disabled,change){const wrapper=el('label',label),s=el('select');s.setAttribute('aria-label',label);for(const o of options){const n=el('option',o.label);n.value=o.id;s.append(n);}s.value=value;s.disabled=disabled||locked;if(label===focusLabel)restoreTarget=s;s.onchange=()=>change(s.value);wrapper.append(s);body.append(wrapper);return s;}
    select('Thinkers',Array.from({length:c.maxThinkers},(_,i)=>({id:String(i+1),label:String(i+1)})),String(state.thinkers.length||1),!c.available,v=>{state=resize(state,+v,raw);draw();onChange(validate(state,raw));});
    if(!c.available){body.append(el('p',c.reason+' No settings are applied.'));for(const title of ['Model','Speed'])select(title,[{id:'unknown',label:'Unavailable in this host'}],'unknown',true,()=>{});if(focusLabel)summary.focus?.();return;}
    state.thinkers.forEach((t,i)=>{const m=c.models.find(m=>m.id===t.modelId);body.append(el('strong',`Thinker ${i+1} · MAX`));select(`Thinker ${i+1} model`,c.models,t.modelId,false,v=>{state=selectModel(state,i,v,raw);draw();onChange(validate(state,raw));});select(`Thinker ${i+1} speed`,m.speeds,t.speedId,!m.independentSpeed,v=>{state.thinkers[i].speedId=v;onChange(validate(state,raw));});if(!m.independentSpeed)body.append(el('p','Speed follows the host session. Independent speed is unavailable.'));});body.append(el('p','Requested settings only. The host must confirm them before starting.'));if(focusLabel){if(restoreTarget&&!restoreTarget.disabled)restoreTarget.focus?.();else summary.focus?.();}
  }draw();return {get:()=>validate(state,raw),setLocked(v){if(locked===Boolean(v))return;locked=Boolean(v);draw();},updateCapabilities(next){raw=next;state=initial(raw);draw();onChange(validate(state,raw));}};
}
