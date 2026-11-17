// Stand-in for `claude -p --input-format stream-json --output-format stream-json`.
// The scenario is chosen by a keyword in each user message.
import {StringDecoder} from 'node:string_decoder';
const arg=n=>{const i=process.argv.indexOf(n);return i>=0?process.argv[i+1]:undefined;};
const model=arg('--model'),schema=process.argv.includes('--json-schema');
const out=o=>process.stdout.write(JSON.stringify(o)+'\n');
let active=null;
function init(over={}){out({type:'system',subtype:'init',model:over.model??model,apiKeySource:over.apiKeySource??'none',tools:schema?['StructuredOutput']:[],mcp_servers:[],permissionMode:'default'});}
function result(extra){out({type:'result',subtype:'success',is_error:false,result:'',usage:{input_tokens:5,output_tokens:9},...extra});active=null;}
function turn(text){
  const kw=(text.match(/\[(\w+)\]/)||[])[1]||'normal';active=kw;
  if(kw==='wrongmodel'){init({model:'claude-haiku-5-5'});return;}
  if(kw==='apikey'){init({apiKeySource:'ANTHROPIC_API_KEY'});return;}
  init();
  if(kw==='die'){process.exit(3);}
  if(kw==='tool'){out({type:'stream_event',event:{type:'content_block_start',index:0,content_block:{type:'tool_use',name:'Bash'}}});return;}
  if(kw==='slow'){out({type:'stream_event',event:{type:'content_block_start',index:0,content_block:{type:'text'}}});out({type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'partial '}}});return;}
  if(kw==='limit'){out({type:'result',subtype:'success',is_error:true,result:'Claude AI usage limit reached'});active=null;return;}
  // A StructuredOutput call the CLI rejects as unparseable; 'brokenjson' lacks only its last brace, 'cutjson' is cut mid-string.
  if(schema&&(kw==='brokenjson'||kw==='cutjson')){
    const full=JSON.stringify({markdown:'## Note\n\nRepaired "quoted" {braces} [kept].',feedback:{findings:[],questions:[],nextDirections:['next']}});
    const sent=kw==='brokenjson'?full.slice(0,-1):full.slice(0,20);
    out({type:'stream_event',event:{type:'content_block_start',index:0,content_block:{type:'tool_use',name:'StructuredOutput',input:{}}}});
    for(let i=0;i<sent.length;i+=16)out({type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:sent.slice(i,i+16)}}});
    out({type:'user',message:{role:'user',content:[{type:'tool_result',is_error:true,content:'<tool_use_error>InputValidationError: StructuredOutput was called with input that could not be parsed as JSON.</tool_use_error>'}]}});
    // The CLI's own retry: it answers after a while unless interrupted first.
    if(kw==='cutjson')setTimeout(()=>{if(active==='cutjson')result({structured_output:{markdown:'## Rewritten',feedback:{findings:[],questions:[],nextDirections:[]}}});},30);
    return;
  }
  if(schema){result({structured_output:{markdown:'## Note\n\nOrganized.',feedback:{findings:[],questions:[],nextDirections:[]}}});return;}
  out({type:'stream_event',event:{type:'content_block_start',index:0,content_block:{type:'thinking'}}});
  out({type:'assistant',message:{model,content:[{type:'thinking',thinking:'SECRET-THOUGHT'}]}});
  const body='Finding café 🧪 '+(text.match(/round (\d+)/)?.[1]??'x')+'\n<!-- loop:continue -->';
  out({type:'stream_event',event:{type:'content_block_start',index:1,content_block:{type:'text'}}});
  // Split a multi-byte character across two writes to exercise the UTF-8 decoder.
  const frame=Buffer.from(JSON.stringify({type:'stream_event',event:{type:'content_block_delta',index:1,delta:{type:'text_delta',text:body}}})+'\n');
  const cut=frame.indexOf(Buffer.from('é'))+1;process.stdout.write(frame.subarray(0,cut));
  setTimeout(()=>{process.stdout.write(frame.subarray(cut));out({type:'assistant',message:{model,content:[{type:'text',text:body}]}});result({result:body});},5);
}
const dec=new StringDecoder('utf8');let buf='';
process.stdin.on('data',d=>{buf+=dec.write(d);for(let i;(i=buf.indexOf('\n'))>=0;){const l=buf.slice(0,i);buf=buf.slice(i+1);if(!l.trim())continue;const m=JSON.parse(l);
  if(m.type==='control_request'&&m.request?.subtype==='interrupt'){out({type:'control_response',response:{subtype:'success',request_id:m.request_id}});if(active)out({type:'result',subtype:'error_during_execution',is_error:true});active=null;continue;}
  if(m.type==='user')turn(m.message.content.map(c=>c.text).join(''));}});
process.stdin.on('end',()=>process.exit(0));
