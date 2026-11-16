#!/usr/bin/env node
import {createInterface} from 'node:readline';
import {defaultDataDir} from './store.mjs';
import {Store} from './store.mjs';
import {Runtime} from './runtime.mjs';
import {serve} from './server.mjs';
import {schemas,toolService} from './tools.mjs';

const store=new Store(process.env.GOAL_LOOP_DATA||defaultDataDir()),runtime=new Runtime(store),web=await serve(runtime),call=toolService(runtime,web);
const send=m=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...m})+'\n');
const rl=createInterface({input:process.stdin,crlfDelay:Infinity}),requests=new Set();
let closing=false;
async function handle(line){
  let m;try{
    if(Buffer.byteLength(line)>600000)throw new Error('Request too large');m=JSON.parse(line);if(m.id===undefined)return;
    let result;
    if(m.method==='initialize')result={protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'goal-loop-studio-native',version:'0.3.0'}};
    else if(m.method==='ping')result={};
    else if(m.method==='tools/list')result={tools:Object.entries(schemas).map(([name,v])=>({name,...v}))};
    else if(m.method==='tools/call'){const value=await call(m.params.name,m.params.arguments??{});result={content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value};}
    else return send({id:m.id,error:{code:-32601,message:'Method not found'}});
    send({id:m.id,result});
  }catch(e){send({id:m?.id??null,error:{code:-32602,message:e.message}});}
}
// Independent requests may wait on transport; state mutations remain synchronous
// or fenced by the runtime. A slow catalog must never block stop.
rl.on('line',line=>{if(closing)return;if(requests.size>=64){send({id:null,error:{code:-32000,message:'Too many pending requests'}});return;}const task=handle(line);requests.add(task);void task.finally(()=>requests.delete(task));});
async function close(){if(closing)return;closing=true;await runtime.close();await Promise.allSettled([...requests]);await web.close();store.close();}
rl.once('close',()=>void close());process.once('SIGTERM',()=>rl.close());process.once('SIGINT',()=>rl.close());
