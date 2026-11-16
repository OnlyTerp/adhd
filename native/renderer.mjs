import {marked} from 'marked';
import DOMPurify from 'dompurify';
import renderMathInElement from 'katex/contrib/auto-render';

// Protect TeX delimiters from Markdown's backslash escaping. Source HTML is
// sanitized before math is rendered; KaTeX trust is disabled explicitly.
globalThis.renderResearchMarkdown=(container,source)=>{
  try {
  const math=[];
  let prefix='GLMATH'+crypto.randomUUID().replaceAll('-','')+'TOKEN';
  while(source.includes(prefix))prefix+='X';
  const protectedSource=source.replace(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]+`)|(\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)|\$\$[\s\S]*?\$\$|\$(?!\s)[^$\n]+?\$)/g,(all,code,formula)=>{
    if(code)return code;
    const token=prefix+math.length+'END';math.push(formula);return token;
  });
  let html=marked.parse(protectedSource,{gfm:true,breaks:false});
  html=html.replace(new RegExp(prefix+'(\\d+)END','g'),(token,n)=>math[+n]===undefined?token:math[+n].replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;'));
  container.innerHTML=DOMPurify.sanitize(html,{USE_PROFILES:{html:true},FORBID_TAGS:['img','style','iframe','form','input','button'],FORBID_ATTR:['style']});
  if(container.firstElementChild?.tagName==='H1'&&container.firstElementChild.textContent==='Research notebook')container.firstElementChild.remove();
  renderMathInElement(container,{delimiters:[{left:'$$',right:'$$',display:true},{left:'\\[',right:'\\]',display:true},{left:'\\(',right:'\\)',display:false},{left:'$',right:'$',display:false}],throwOnError:false,trust:false,strict:'warn'});
  for(const a of container.querySelectorAll('a')){if(!a.getAttribute('href')?.startsWith('#')){a.rel='noopener noreferrer';a.target='_blank';}}
  }catch(error){container.textContent=source;container.dataset.renderError=error.message;}
};
