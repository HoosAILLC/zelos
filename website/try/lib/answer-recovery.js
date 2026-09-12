/** Resume a saved answer with read-only requests. Never repeat its AI request. */
export async function recoverAnswer({requestId,threadId,answerId,api,signal,onUpdate=()=>{},
  maxAttempts=80,wait=ms=>new Promise(resolve=>setTimeout(resolve,ms))}) {
  let lastError;
  for(let attempt=0;attempt<maxAttempts;attempt++) {
    signal?.throwIfAborted();
    try{
      if(!threadId||!answerId){const info=await api.askRequest(requestId);threadId=info.id;answerId=info.answerId;}
      const saved=await api.conversation(threadId);signal?.throwIfAborted();
      const answer=saved.messages.find(m=>m.id===answerId&&m.role==='assistant');
      if(!answer)throw new Error('The saved answer is not available yet.');
      onUpdate({...answer,threadId});
      if(answer.state!=='streaming')return {...answer,threadId};
    }catch(e){if(e.name==='AbortError'||e.status===401||e.status===403)throw e;lastError=e;}
    if(attempt<maxAttempts-1)await wait(Math.min(5000,1000+attempt*500));
  }
  throw lastError||new Error('The answer is still saved on your Spark. Reopen this conversation to check it.');
}
