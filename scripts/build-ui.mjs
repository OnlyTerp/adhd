import {readFileSync,writeFileSync} from 'node:fs';
let html=readFileSync(new URL('../ui/template.html',import.meta.url),'utf8');
const config=readFileSync(new URL('../ui/thinker-config.mjs',import.meta.url),'utf8').replaceAll('export function ','function ');
const configScript='const ThinkerConfig=(()=>{'+config+';return {mount};})();';
html=html.replace('</style>',readFileSync(new URL('../ui/thinker-config.css',import.meta.url),'utf8')+'</style>');
const old=html.indexOf('\nlet seq=0, sessionId=null'),end=html.indexOf('</script>',old);
if(old<0||end<0)throw new Error('Expected integrated studio script');
html=html.slice(0,old)+'\n'+configScript+'\n'+readFileSync(new URL('../ui/studio.js',import.meta.url),'utf8')+html.slice(end);
writeFileSync(new URL('../worker/ui.js',import.meta.url),'export default '+JSON.stringify(html)+';\n');
