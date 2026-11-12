import type { RequestHandler } from 'express';

export const ARTIFACT_PREVIEW_POLICY: string =
  "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'; worker-src 'none'";
export const ARTIFACT_PREVIEW_SHELL: string = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><script>
let received=false;
addEventListener('message',event=>{
 if(received||event.source!==parent||event.data?.type!=='kisuno-artifact-preview'||typeof event.data.html!=='string'||event.data.html.length>2097152)return;
 received=true;
 const parsed=new DOMParser().parseFromString(event.data.html,'text/html');
 parsed.querySelectorAll('iframe,frame,frameset,object,embed,link,base,meta').forEach(node=>node.remove());
 parsed.querySelectorAll('a').forEach(node=>{if(!node.getAttribute('href')?.startsWith('#'))node.removeAttribute('href');node.removeAttribute('target');node.removeAttribute('ping')});
 const scripts=[];
 parsed.querySelectorAll('script').forEach(node=>{if(!node.hasAttribute('src'))scripts.push({type:node.getAttribute('type'),code:node.textContent});node.remove()});
 document.head.replaceChildren(...Array.from(parsed.head.childNodes).map(node=>document.importNode(node,true)));
 document.body.replaceChildren(...Array.from(parsed.body.childNodes).map(node=>document.importNode(node,true)));
 for(const [target,source] of [[document.documentElement,parsed.documentElement],[document.body,parsed.body]])for(const attribute of source.attributes)if(/^(class|style|lang|dir|id|onload|data-.+|aria-.+)$/.test(attribute.name))target.setAttribute(attribute.name,attribute.value);
 const viewport=document.createElement('meta');viewport.name='viewport';viewport.content='width=device-width,initial-scale=1';document.head.append(viewport);
 scripts.forEach(value=>{const script=document.createElement('script');if(value.type)script.type=value.type;script.textContent=value.code;document.body.append(script)});
 document.dispatchEvent(new Event('DOMContentLoaded'));
 window.dispatchEvent(new Event('load'));
});
const ready=()=>parent.postMessage({type:'kisuno-artifact-ready'},'*');
if(document.readyState==='complete')ready();else addEventListener('load',ready,{once:true});
</script></body></html>`;

/** Serve a constant, data-free loader; HTTP CSP survives script-driven document replacement. */
export const artifactPreviewHandler: RequestHandler = (_req, res): void => {
  res.set({
    'Content-Security-Policy': ARTIFACT_PREVIEW_POLICY,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Expose-Headers': 'Content-Security-Policy',
  });
  res.type('html').send(ARTIFACT_PREVIEW_SHELL);
};
