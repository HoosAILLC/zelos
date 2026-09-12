/** Brief feedback after the server confirms completion. Totals live in Progress. */
let toast=null,timer=null;
export function celebrateCompletion() {
  if(typeof document==='undefined'||!document.body)return;
  clearTimeout(timer);toast?.remove();
  toast=document.createElement('div');toast.className='completion-pulse';toast.setAttribute('role','status');
  toast.textContent='✓ Finished. That’s progress.';document.body.appendChild(toast);
  timer=setTimeout(()=>{toast?.remove();toast=null;},2400);
}
