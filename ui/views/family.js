/** Owner adapter. The guest portal never imports the owner API module. */
import {request,requestFamilyDownload} from '../lib/api.js';
import {mountFamily} from '../lib/family-client.js';
import {useFamilyDocument} from './documents.js';
let root=null,controller=null;
export function renderFamily(){
  if(!root){
    root=document.createElement('div');root.className='view view-family';
    controller=mountFamily(root,{
      request:(action,input={})=>action?request('/api/family/action',{method:'POST',body:{action,input}}):request('/api/family'),
      download:requestFamilyDownload,
      publishSources:()=>request('/api/family/sources'),
      publishSnapshot:input=>request('/api/family/snapshot',{method:'POST',body:input}),
      reviewDocument:async record=>{await useFamilyDocument(record);window.location.hash='#/documents';},
    });
  }else if(!root.isConnected)controller.refresh();
  return root;
}
