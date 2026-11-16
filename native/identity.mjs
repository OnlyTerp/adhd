import {spawn, spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
export function processIdentity(pid) {
  if(!Number.isInteger(pid)||pid<1)return {status:'unknown'};
  try{process.kill(pid,0);}catch(e){return {status:e.code==='ESRCH'?'dead':'unknown'};}
  try{
    let start;
    if(process.platform==='win32'){
      const r=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`],{encoding:'utf8',windowsHide:true,timeout:3000});
      if(r.status!==0||!/^\d+$/.test(r.stdout?.trim()))return {status:'unknown'};
      start=r.stdout.trim();
    }else{const stat=readFileSync(`/proc/${pid}/stat`,'utf8');start=stat.slice(stat.lastIndexOf(')')+2).split(' ')[19];}
    return {status:'alive',pid,start};
  }catch{return {status:'unknown'};}
}
export function sameProcess(saved){
  // A multi-process host (Codex app-server plus Claude workers) is dead only when every member is.
  if(Array.isArray(saved?.members)){if(!saved.members.length)return 'unknown';const states=saved.members.map(sameProcess);return states.every(s=>s==='dead')?'dead':states.some(s=>s==='alive')?'alive':'unknown';}
  if(!saved?.pid||!saved?.start)return 'unknown';
  const now=processIdentity(saved.pid);
  return now.status==='dead'?'dead':now.status==='alive'?(now.start===saved.start?'alive':'dead'):'unknown';
}
// Same identity as processIdentity, without blocking the event loop (thinkers keep running).
export function processIdentityAsync(pid){
  if(!Number.isInteger(pid)||pid<1)return Promise.resolve({status:'unknown'});
  try{process.kill(pid,0);}catch(e){return Promise.resolve({status:e.code==='ESRCH'?'dead':'unknown'});}
  if(process.platform!=='win32')return Promise.resolve(processIdentity(pid));
  return new Promise(resolve=>{
    let out='';const p=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',`(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`],{windowsHide:true,stdio:['ignore','pipe','ignore']});
    const timer=setTimeout(()=>{p.kill();resolve({status:'unknown'});},5000);
    p.stdout.on('data',d=>{out+=d;});p.on('error',()=>{clearTimeout(timer);resolve({status:'unknown'});});
    p.on('close',code=>{clearTimeout(timer);const start=out.trim();resolve(code===0&&/^\d+$/.test(start)?{status:'alive',pid,start}:{status:'unknown'});});
  });
}
