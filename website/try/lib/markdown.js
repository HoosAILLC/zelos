/** Small, inert Markdown renderer for model answers. Only DOM nodes and text;
 * raw HTML stays text, images never load, and links need an explicit click. */
import { el } from './dom.js';

const text=value=>document.createTextNode(value);
const entity=/&(?:amp|lt|gt|quot|apos|nbsp|#\d{1,7}|#x[\da-f]{1,6});/gi;
const decode=value=>value.replace(entity,token=>{
  const name=token.slice(1,-1).toLowerCase(),named={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:'\u00a0'};
  if(named[name])return named[name];
  const n=name.startsWith('#x')?parseInt(name.slice(2),16):Number(name.slice(1));
  return n>0&&n<=0x10ffff&&!(n>=0xd800&&n<=0xdfff)?String.fromCodePoint(n):token;
});
function safeLink(value){
  try{const url=new URL(decode(value));return ['https:','http:'].includes(url.protocol)&&!url.username&&!url.password&&!/[\x00-\x20\x7f]/.test(value)?url.href:null;}catch{return null;}
}
function bracketEnd(value,start,open,close,budget){
  let level=0;
  for(let i=start;i<value.length;i++){
    if(--budget.left<0)return -1;
    if(value[i]==='\\'){i++;continue;}
    if(value[i]===open)level++;
    if(value[i]===close&&!--level)return i;
  }
  return -1;
}
function closing(value,delimiter,start,budget){
  let end=start;
  while(budget.left>0){
    const next=value.indexOf(delimiter,end);budget.left-=(next<0?value.length:next)-end+delimiter.length;end=next;
    if(end<0)return -1;
    if(value[end-1]==='\\'||/\s/.test(value[end-1]||'')){end+=delimiter.length;continue;}
    let run=delimiter.length;while(value[end+run]===delimiter[0])run++;
    if(delimiter.length===2&&run===3)end++;
    if(delimiter[0]==='_'&&/[\p{L}\p{N}]/u.test(value[end+delimiter.length]||'')){end+=delimiter.length;continue;}
    return end;
  }
  return -1;
}
export function inlineMarkdown(value,depth=0){
  if(depth>12)return [text(value)];
  const budget={left:value.length*8+256};
  const nodes=[];let plain='';
  const flush=()=>{if(plain){nodes.push(text(decode(plain)));plain='';}};
  for(let i=0;i<value.length;){
    if(budget.left<=0){plain+=value.slice(i);break;}
    if(value[i]==='\\'&&/[!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~]/.test(value[i+1]||'')){plain+=value[i+1];i+=2;continue;}
    if(value[i]==='`'){
      const marks=/^`+/.exec(value.slice(i))[0],end=value.indexOf(marks,i+marks.length);
      if(end!==-1){flush();let code=value.slice(i+marks.length,end).replace(/\n/g,' ');if(/^ .+ $/.test(code)&&/\S/.test(code))code=code.slice(1,-1);nodes.push(el('code',{text:code}));i=end+marks.length;continue;}
    }
    const image=value.startsWith('![',i),linkStart=image?i+1:i;
    if(value[linkStart]==='['){
      const end=bracketEnd(value,linkStart,'[',']',budget);
      if(end!==-1&&value[end+1]==='('){
        const urlEnd=bracketEnd(value,end+1,'(',')',budget);
        if(urlEnd!==-1){
          const label=value.slice(linkStart+1,end),raw=value.slice(end+2,urlEnd).trim();
          const destination=/^(?:<([^<>]+)>|([^\s]+))(?:\s+["'][\s\S]*["'])?$/.exec(raw);
          const href=destination&&safeLink(destination[1]||destination[2]);
          flush();nodes.push(image?el('span',{class:'markdown-image-note',text:`Image: ${label||'description unavailable'}`})
            :href?el('a',{href,target:'_blank',rel:'noopener noreferrer'},inlineMarkdown(label,depth+1))
              :el('span',{},inlineMarkdown(label||raw,depth+1)));
          i=urlEnd+1;continue;
        }
      }
    }
    const auto=/^<(https?:\/\/[^<>\s]+)>/.exec(value.slice(i));
    if(auto&&safeLink(auto[1])){flush();nodes.push(el('a',{href:safeLink(auto[1]),target:'_blank',rel:'noopener noreferrer',text:auto[1]}));i+=auto[0].length;continue;}
    let matched=false;
    for(const marker of ['***','___','**','__','~~','*','_']){
      if(!value.startsWith(marker,i)||!value[i+marker.length]||/\s/.test(value[i+marker.length]))continue;
      if(marker[0]==='_'&&/[\p{L}\p{N}]/u.test(value[i-1]||''))continue;
      const end=closing(value,marker,i+marker.length,budget);if(end===-1)continue;
      flush();const children=inlineMarkdown(value.slice(i+marker.length,end),depth+1);
      nodes.push(marker.length===3?el('strong',{},el('em',{},children)):el(marker==='~~'?'del':marker.length===2?'strong':'em',{},children));
      i=end+marker.length;matched=true;break;
    }
    if(matched)continue;
    plain+=value[i++];
  }
  flush();return nodes;
}

const listMatch=line=>/^( *)([-+*]|\d{1,9}[.)]) +(.*)$/.exec(line);
const fence=line=>/^ {0,3}(`{3,}|~{3,})([^`]*)$/.exec(line);
const heading=line=>/^ {0,3}(#{1,6}) +(.+?) *$/.exec(line);
const rule=line=>/^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/.test(line);
function cells(line){
  let value=line.trim();if(value.startsWith('|'))value=value.slice(1);if(/(?<!\\)\|$/.test(value))value=value.slice(0,-1);
  const result=[];let cell='',ticks=0;
  for(let i=0;i<value.length;i++){
    if(value[i]==='\\'&&value[i+1]){cell+=value[i]+value[++i];continue;}
    if(value[i]==='`'){let end=i;while(value[end]==='`')end++;const run=end-i;ticks=ticks===run?0:!ticks?run:ticks;cell+=value.slice(i,end);i=end-1;continue;}
    if(value[i]==='|'&&!ticks){result.push(cell.trim());cell='';}else cell+=value[i];
  }
  result.push(cell.trim());return result;
}
function tableAt(lines,i){return i+1<lines.length&&lines[i].includes('|')&&lines[i+1].includes('|')&&cells(lines[i+1]).every(v=>/^:?-{3,}:?$/.test(v))&&cells(lines[i]).length===cells(lines[i+1]).length;}
const blockStart=(lines,i)=>fence(lines[i])||heading(lines[i])||rule(lines[i])||listMatch(lines[i])||/^ {0,3}>/.test(lines[i])||tableAt(lines,i);
function paragraph(lines){
  const nodes=[];
  lines.forEach((line,i)=>{const hard=/ {2,}$|\\$/.test(line);nodes.push(...inlineMarkdown(line.replace(/ {2,}$|\\$/,'')));if(i<lines.length-1)nodes.push(hard?el('br'):text(' '));});
  return el('p',{},nodes);
}
function blocks(lines,depth=0){
  if(depth>12)return [paragraph(lines)];
  const nodes=[];
  for(let i=0;i<lines.length;){
    if(!lines[i].trim()){i++;continue;}
    const code=fence(lines[i]);
    if(code){
      const content=[],language=code[2].trim().split(/\s/)[0].replace(/[^a-zA-Z0-9_+#.-]/g,'').slice(0,30);i++;
      const close=new RegExp(`^ {0,3}${code[1][0]}{${code[1].length},} *$`);
      while(i<lines.length&&!close.test(lines[i]))content.push(lines[i++]);
      if(i<lines.length)i++;
      nodes.push(el('pre',{class:'markdown-code',...(language?{'data-language':language}:{}),tabindex:'0'},el('code',{text:content.join('\n')})));continue;
    }
    const title=heading(lines[i]);
    if(title){nodes.push(el(`h${Math.min(6,title[1].length+1)}`,{},inlineMarkdown(title[2].replace(/ +#+ *$/,''))));i++;continue;}
    if(rule(lines[i])){nodes.push(el('hr'));i++;continue;}
    if(/^ {0,3}>/.test(lines[i])){
      const quoted=[];while(i<lines.length&&/^ {0,3}>/.test(lines[i]))quoted.push(lines[i++].replace(/^ {0,3}> ?/,''));
      nodes.push(el('blockquote',{},blocks(quoted,depth+1)));continue;
    }
    if(tableAt(lines,i)){
      const headers=cells(lines[i]),align=cells(lines[i+1]).map(v=>v.startsWith(':')&&v.endsWith(':')?'center':v.endsWith(':')?'right':'left');i+=2;
      const row=(values,tag)=>el('tr',{},headers.map((_,j)=>el(tag,{class:`align-${align[j]}`,...(tag==='th'?{scope:'col'}:{})},inlineMarkdown(values[j]||''))));
      const rows=[];while(i<lines.length&&lines[i].trim()&&lines[i].includes('|'))rows.push(row(cells(lines[i++]),'td'));
      nodes.push(el('div',{class:'markdown-table',role:'region','aria-label':'Table in answer',tabindex:'0'},el('table',{},[el('thead',{},row(headers,'th')),el('tbody',{},rows)])));continue;
    }
    const first=listMatch(lines[i]);
    if(first){
      const indent=first[1].length,ordered=/^\d/.test(first[2]),items=[];
      while(i<lines.length){
        const match=listMatch(lines[i]);if(!match||match[1].length!==indent||/^\d/.test(match[2])!==ordered)break;
        const width=match[0].length-match[3].length,part=[match[3]];i++;
        while(i<lines.length){
          if(!lines[i].trim()){
            let next=i+1;while(next<lines.length&&!lines[next].trim())next++;
            const sibling=next<lines.length&&listMatch(lines[next]);
            if(sibling&&sibling[1].length===indent){i=next;break;}
            if(next>=lines.length||/^ */.exec(lines[next])[0].length<=indent)break;
            part.push('');i++;continue;
          }
          const spaces=/^ */.exec(lines[i])[0].length;
          if(spaces<=indent)break;
          part.push(lines[i++].slice(Math.min(width,spaces)));
        }
        const task=/^\[([ xX])\] +/.exec(part[0]);if(task)part[0]=`${task[1].trim()?'✓':'○'} ${part[0].slice(task[0].length)}`;
        items.push(el('li',{},blocks(part,depth+1)));
      }
      nodes.push(el(ordered?'ol':'ul',ordered&&parseInt(first[2],10)!==1?{start:parseInt(first[2],10)}:null,items));continue;
    }
    const linesInParagraph=[lines[i++]];
    while(i<lines.length&&lines[i].trim()&&!blockStart(lines,i))linesInParagraph.push(lines[i++]);
    nodes.push(paragraph(linesInParagraph));
  }
  return nodes;
}
export function renderMarkdown(target,value){
  const lines=String(value??'').replace(/\r\n?/g,'\n').split('\n').map(line=>line.replace(/^\t+/,tabs=>'    '.repeat(tabs.length)));
  target.textContent='';target.replaceChildren(...blocks(lines));
}
/** Text-only copying keeps paragraph, list and table boundaries. */
export function markdownText(target){
  function read(node){
    const tag=node.tagName?.toLowerCase();
    if(node.nodeType===3||tag==='#text')return node.textContent||'';
    const children=[...(node.childNodes||node.children||[])];
    const content=children.length?children.map(read).join(''):node.textContent||'';
    if(tag==='br')return '\n';
    if(tag==='li')return `${node.parentNode?.tagName?.toLowerCase()==='ol'?`${[...(node.parentNode.children||[])].indexOf(node)+(Number(node.parentNode.getAttribute('start'))||1)}.`:'•'} ${content.trim()}\n`;
    if(tag==='td'||tag==='th')return content+'\t';
    if(tag==='tr')return content.trimEnd()+'\n';
    if(['p','h2','h3','h4','h5','h6','pre','blockquote','ul','ol','table'].includes(tag))return content.trimEnd()+'\n\n';
    return content;
  }
  return read(target).trim();
}
