import {readFile,rm} from 'node:fs/promises';
import {packageWorker} from './package-worker.mjs';
const manifest=JSON.parse(await readFile('.openai/hosting.json','utf8'));
if(!manifest.project_id)throw new Error('Supply the verified existing Site configuration. Do not register a replacement Site.');
await rm('dist',{recursive:true,force:true});
await packageWorker(process.cwd(),process.cwd()+'/dist',manifest);
console.log('Bundled Worker and migrations packaged locally. No deployment or hosted migration performed.');
