import {build} from 'esbuild';
import {mkdir,copyFile,cp} from 'node:fs/promises';
export async function packageWorker(root,output,manifest){
 if(!manifest.project_id)throw new Error('A verified existing Site project_id is required; this function does not register Sites.');
 if(manifest.d1!=='DB'||!manifest.capabilities?.includes('mcp'))throw new Error('DB/mcp declarations required');
 await mkdir(output+'/server',{recursive:true});await mkdir(output+'/.openai',{recursive:true});
 await build({entryPoints:[root+'/worker/index.js'],outfile:output+'/server/index.js',bundle:true,format:'esm',platform:'neutral',target:'es2022',metafile:true});
 await copyFile(root+'/.openai/hosting.json',output+'/.openai/hosting.json');
 await cp(root+'/drizzle',output+'/.openai/drizzle',{recursive:true});
}
