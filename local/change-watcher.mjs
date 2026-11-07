// One resumable notification request per consumer, independent of native work.
// The journal is a hint to re-read authoritative data; it never claims a task.
export function watchChanges({request,onChange,onError=()=>{},cursor,onCursor=()=>{},retryMs=1000}){
  const controller=new AbortController();let failures=0;
  const pause=ms=>new Promise(resolve=>{const done=()=>{clearTimeout(timer);controller.signal.removeEventListener('abort',done);resolve();};const timer=setTimeout(done,ms);timer.unref?.();controller.signal.addEventListener('abort',done,{once:true});if(controller.signal.aborted)done();});
  const finished=(async()=>{
    while(!controller.signal.aborted){
      try{
        const page=await request('/v2/changes?'+new URLSearchParams({...(cursor===undefined?{}:{after:String(cursor)})}),controller.signal);
        if(controller.signal.aborted)break;
        if(!Number.isSafeInteger(page.cursor)||!Array.isArray(page.changes))throw Error('更新通知返回无效');
        if(page.reset||page.changes.length)await onChange(page);
        // A failed consumer keeps the old cursor and can replay invalidations.
        cursor=page.cursor;await onCursor(cursor);failures=0;
      }catch(error){
        if(controller.signal.aborted)break;
        onError(error);failures++;
        await pause(Math.min(30000,retryMs*2**Math.min(failures-1,5)));
      }
    }
  })();
  return {stop(){controller.abort();},finished,get cursor(){return cursor;}};
}
