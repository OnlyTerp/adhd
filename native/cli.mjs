#!/usr/bin/env node
import {readFileSync} from 'node:fs';
import {defaultDataDir} from './store.mjs';
import {randomUUID} from 'node:crypto';
import {Store} from './store.mjs';
import {Runtime} from './runtime.mjs';
import {serve} from './server.mjs';

const [command,...args]=process.argv.slice(2);
const option=name=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];};
const dataDir=option('--data')||process.env.GOAL_LOOP_DATA||defaultDataDir();
const store=new Store(dataDir),runtime=new Runtime(store);let web,closing=false;
async function close(){if(closing)return;closing=true;await runtime.close();await web?.close();store.close();process.stdin.removeAllListeners('data');process.stdin.pause();}
try{
  if(command==='catalog'){console.log(JSON.stringify(await runtime.catalog(),null,2));await close();}
  else if(command==='verify-package'){const bundle=JSON.parse(readFileSync(option('--package'),'utf8'));console.log(JSON.stringify(Store.verifyPackage(bundle),null,2));await close();}
  else if(command==='restore'){const bundle=JSON.parse(readFileSync(option('--package'),'utf8'));console.log(JSON.stringify(store.restore(bundle,option('--request-id')),null,2));await close();}
  else if(command==='status'){console.log(JSON.stringify(runtime.status(option('--session')),null,2));await close();}
  else if(command==='run'||command==='serve'||command==='view'){
    const lifetime=option('--lifetime');
    if(lifetime!==undefined&&(!Number.isFinite(Number(lifetime))||Number(lifetime)<=0||Number(lifetime)>86400))throw new Error('--lifetime must be between 0 and 86400 seconds');
    const spec=command==='view'?null:JSON.parse(readFileSync(option('--spec'),'utf8'));
    const id=spec?store.prepare({...spec,requestId:spec.requestId??randomUUID()}):option('--session');store.workspace(id);
    web=await serve(runtime,{port:Number(option('--port')||0)});
    console.log(JSON.stringify({sessionId:id,url:web.url(id),dataDir}));
    if(command==='run')runtime.start(id,spec.configuration);
    const deadline=lifetime===undefined?null:setTimeout(()=>void close(),Number(lifetime)*1000);
    for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{clearTimeout(deadline);void close();});
    process.stdin.setEncoding('utf8');process.stdin.on('data',text=>{if(text.trim()==='quit'){clearTimeout(deadline);void close();}});
  }else{console.error('Usage: node native/cli.mjs catalog | run --spec FILE | serve --spec FILE | status --session ID | verify-package --package FILE | restore --package FILE --request-id ID [--data DIR]');process.exitCode=1;await close();}
}catch(e){console.error(e.message);process.exitCode=1;await close();}
