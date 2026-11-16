import {build} from 'esbuild';
import {cpSync,mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const out=new URL('./assets/',import.meta.url);mkdirSync(out,{recursive:true});
await build({entryPoints:[fileURLToPath(new URL('./renderer.mjs',import.meta.url))],outfile:fileURLToPath(new URL('renderer.js',out)),bundle:true,minify:true,format:'iife',platform:'browser',target:'es2022'});
cpSync(new URL('../node_modules/katex/dist/katex.min.css',import.meta.url),new URL('katex.min.css',out));
cpSync(new URL('../node_modules/katex/dist/fonts/',import.meta.url),new URL('fonts/',out),{recursive:true});
for(const name of ['marked','dompurify','katex'])cpSync(new URL('../node_modules/'+name+'/LICENSE',import.meta.url),new URL(name+'-LICENSE',out));
