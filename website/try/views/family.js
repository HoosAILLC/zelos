/** The current Family component with a fictional-person switch. All external
 * mutations remain unavailable through the demo transport. */
import {request,requestFamilyDownload} from '../lib/api.js';
import {mountFamily} from '../lib/family-client.js';
import {el} from '../lib/dom.js';
let root,controller,person='alex';
export function renderFamily(){
  if(!root){
    root=el('div',{class:'view view-family'});
    const selector=el('select',{class:'family-input','aria-label':'Fictional person'},[
      el('option',{value:'alex',text:'Alex Row · owner'}),el('option',{value:'jamie',text:'Jamie Row · parent'}),el('option',{value:'sam',text:'Sam Lee · collaborator'}),
    ]);
    const framing=el('section',{class:'family-panel demo-family-framing'},[
      el('h2',{text:'Explore a fictional household'}),
      el('p',{class:'family-note',text:'The current Family interface, with sample records only. Switch people to see selected access. Saving, invitations, sharing, credentials and uploads require the installed app.'}),
      el('label',{class:'family-field'},[el('span',{text:'View as'}),selector]),
    ]);
    const workspace=el('div');root.append(framing,workspace);
    const mount=()=>{controller?.destroy();const selected=person;controller=mountFamily(workspace,{
      request:(action,input={})=>action?request('/api/family/action',{method:'POST',body:{action,input}}):request('/api/family?person='+selected),
      download:requestFamilyDownload,
      publishSources:()=>request('/api/family/sources'),
      publishSnapshot:input=>request('/api/family/snapshot',{method:'POST',body:input}),
    });};
    mount();selector.addEventListener('change',()=>{person=selector.value;mount();});
  }else if(!root.isConnected)controller.refresh();
  return root;
}
