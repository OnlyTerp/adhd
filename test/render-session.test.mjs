import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.js';
import {fixture} from './fixture.mjs';
const setup=()=>{const {DB,raw}=fixture();return {raw,async mcp(method,params={},owner='owner'){const response=await worker.fetch(new Request('https://site.test/mcp',{method:'POST',headers:{'content-type':'application/json','oai-authenticated-user-id':owner},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})}),{DB});return (await response.json()).result;}};};
test('only deliberate render entrypoint advertises the registered app resource',async()=>{
 const {mcp}=setup();const {tools}=await mcp('tools/list');const render=tools.find(t=>t.name==='render_session');
 assert.deepEqual(render.annotations,{readOnlyHint:true,destructiveHint:false,openWorldHint:false,idempotentHint:true});
 assert.deepEqual(tools.filter(t=>t._meta?.ui?.resourceUri).map(t=>t.name),['render_session']);
 assert.equal(render.inputSchema.additionalProperties,false);
 const resource=(await mcp('resources/read',{uri:render._meta.ui.resourceUri})).contents[0];
 assert.equal(resource.mimeType,'text/html;profile=mcp-app');assert.match(resource.text,/ui\/initialize/);
});
test('render reads existing owner document repeatedly without writes or launch',async()=>{
 const {mcp,raw}=setup();const call=(name,args,owner)=>mcp('tools/call',{name,arguments:args},owner);
 const session=(await call('session_create',{goal:'Visible work only'})).structuredContent;
 await call('document_replace',{sessionId:session.id,eventId:'doc',expectedRevision:0,markdown:'# Research'});
 const before=raw.prepare('SELECT total_changes() AS n').get().n;
 const first=await call('render_session',{sessionId:session.id});const again=await call('render_session',{sessionId:session.id});
 assert.equal(first.structuredContent.document,'# Research');assert.equal(first.structuredContent.launchRequest,null);
 assert.deepEqual(first,again);assert.equal(raw.prepare('SELECT total_changes() AS n').get().n,before);
 const denied=await call('render_session',{sessionId:session.id},'another-owner');assert.equal(denied.isError,true);assert.equal(denied.structuredContent,undefined);
 const missing=await call('render_session',{sessionId:'not-found'});assert.equal(missing.isError,true);
 const invalid=await call('render_session',{sessionId:session.id,after:0});assert.equal(invalid.isError,true);
});
