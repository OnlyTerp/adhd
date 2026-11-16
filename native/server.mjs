import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import studioHTML from '../worker/ui.js';

const script=readFileSync(new URL('./browser.js',import.meta.url),'utf8');
// The shared view exposes an explicit native adapter; it never rewrites its DOM.
if(!studioHTML.includes('globalThis.goalLoopNative'))throw new Error('Rebuild the Studio view with its native adapter interface.');
const nativeTemplate=studioHTML;
const html=nativeTemplate.replace('</head>','<link rel="stylesheet" href="/native-assets/katex.min.css"><script src="/native-assets/renderer.js"></script></head>').replace('</body>','<script>'+script+'</script></body>');
export async function serve(runtime,{port=0}={}){
  let origin,catalogPromise;
  const server=createServer(async(req,res)=>{
    const send=(status,body,type='application/json')=>{res.writeHead(status,{'content-type':type,'cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer','content-security-policy':"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; frame-ancestors 'none'; connect-src 'self'"});res.end(type==='application/json'?JSON.stringify(body):body);};
    try{
      if(req.headers.host!==new URL(origin).host||(req.headers.origin&&req.headers.origin!==origin))return send(403,{error:'Origin not permitted'});
      const url=new URL(req.url,origin);
      if(req.method==='GET'&&/^\/native-assets\/(renderer\.js|katex\.min\.css|fonts\/[a-zA-Z0-9_.-]+\.woff2?)$/.test(url.pathname)){
        const name=url.pathname.slice('/native-assets/'.length),content=readFileSync(new URL('./assets/'+name,import.meta.url));
        return send(200,content,name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'font/woff2');
      }
      if(req.method==='GET'&&url.pathname==='/'){
        runtime.store.workspace(url.searchParams.get('session'));return send(200,html,'text/html;charset=utf-8');
      }
      if(req.method==='GET'&&url.pathname==='/api/runtime/catalog'){
        if(!catalogPromise)catalogPromise=runtime.catalog().catch(e=>{catalogPromise=null;throw e;});return send(200,await catalogPromise);
      }
      if(req.method!=='POST')return send(404,{error:'Not found'});
      if(req.headers.origin!==origin||!req.headers['content-type']?.includes('application/json'))return send(403,{error:'Same-origin JSON requests required'});
      const chunks=[];let receivedBytes=0;for await(const chunk of req){receivedBytes+=chunk.length;if(receivedBytes>600000)throw new Error('Request too large');chunks.push(chunk);}
      const input=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks,receivedBytes)));let result;
      if(url.pathname==='/api/tools'&&input.name==='session_status')result=runtime.status(input.arguments?.sessionId,{includeDrafts:true});
      else if(url.pathname==='/api/runtime/start')result=runtime.start(input.sessionId,input.configuration);
      else if(url.pathname==='/api/runtime/control')result=await runtime.control(input.sessionId,input.action,{trackerContextBytes:input.trackerContextBytes});
      else if(url.pathname==='/api/runtime/evidence')result=runtime.evidence(input.sessionId,input.evidence);
      else if(url.pathname==='/api/runtime/content')result=runtime.store.content(input.sessionId);
      else if(url.pathname==='/api/runtime/sources')result=runtime.store.sourcePage(input.sessionId,input.after,input.limit);
      else if(url.pathname==='/api/runtime/source'){runtime.store.workspace(input.sessionId);result=runtime.store.db.prepare('SELECT * FROM sources WHERE session_id=? AND uid=?').get(input.sessionId,input.sourceId);if(!result)throw new Error('Unknown source reference');}
      else if(url.pathname==='/api/runtime/revisions')result=runtime.store.revisionPage(input.sessionId,input.after,input.limit);
      else if(url.pathname==='/api/runtime/export')result=runtime.store.package(input.sessionId);
      else if(url.pathname==='/api/runtime/document')result={markdown:runtime.store.document(input.sessionId)};
      else return send(404,{error:'Unknown operation'});
      return send(200,result);
    }catch(e){send(400,{error:e.message});}
  });
  server.requestTimeout=30000;server.headersTimeout=10000;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  origin=`http://127.0.0.1:${server.address().port}`;
  return {origin,url:id=>`${origin}/?session=${encodeURIComponent(id)}`,close:()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();})};
}
