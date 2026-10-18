import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { apiError, sha256File, nowIso } from './util.js';
import { withProjectLock, operationSignal, checkCancelled } from './workflow.js';

export async function windowsHealth() {
  const remote=config().render.remote;
  if(!remote?.url) return {ok:false,reason:'尚未配置 Windows 渲染端',wps:{available:false},powerpoint:{available:false}};
  try {
    const r=await fetch(remote.url.replace(/\/$/,'')+'/health',{signal:AbortSignal.timeout(8000)});
    if(!r.ok) throw new Error('HTTP '+r.status);
    return await r.json();
  }catch(e){return {ok:false,reason:e.message,wps:{available:false},powerpoint:{available:false}};}
}
export async function renderWindows(source,outDir,opts={}) {
  return withProjectLock('windows-render:queue',async()=>{
    checkCancelled();
    const cfg=config().render,remote=cfg.remote;
    if(!remote?.url || !remote.token) throw apiError('ENGINE_UNAVAILABLE','需要配置 Windows 服务地址及调用令牌');
    const engine=opts.engine || cfg.engine,health=await windowsHealth();
    if(!health.ok || !health[engine]?.available) throw apiError('ENGINE_UNAVAILABLE','Windows '+engine+' 不可用：'+(health.reason||'原生引擎未就绪'));
    const started=Date.now(),deadline=started+(opts.timeoutMs || cfg.timeoutMs);
    const data=await fsp.readFile(source);
    let payload;
    while(Date.now()<deadline) {
      checkCancelled();
      const signal=operationSignal()?AbortSignal.any([operationSignal(),AbortSignal.timeout(Math.max(1,deadline-Date.now()))]):AbortSignal.timeout(Math.max(1,deadline-Date.now()));
      const r=await fetch(remote.url.replace(/\/$/,'')+'/render',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:remote.token,engine,pptx_b64:data.toString('base64')}),signal});
      if(r.status===409){await new Promise((resolve)=>setTimeout(resolve,1000));continue;}
      payload=await r.json();
      if(!r.ok || !payload.ok) throw apiError('RENDER_FAILED',payload.error||'远端渲染失败：HTTP '+r.status);
      break;
    }
    checkCancelled();
    if(!payload) throw apiError('RENDER_FAILED','Windows 渲染端持续忙碌或超时');
    const pages=Array.isArray(payload.pngs)?payload.pngs:Object.entries(payload.pngs || {}).sort((a,b)=>Number(a[0])-Number(b[0])).map(([slide,data])=>({slide:Number(slide),data}));
    if(payload.engine!==engine || !pages.length || payload.source_sha256!==await sha256File(source)) throw apiError('RENDER_FAILED','Windows 响应缺少真实引擎、文件 SHA 或预览');
    await fsp.mkdir(outDir,{recursive:true});
    const files=[];
    for(let i=0;i<pages.length;i++) {
      const page=pages[i],bytes=Buffer.from(page.data || page.b64 || page.base64 || '', 'base64');
      if(page.slide && page.slide!==i+1) throw apiError('RENDER_FAILED','远端页码不连续');
      if(!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw apiError('RENDER_FAILED','远端返回无效 PNG');
      const name='slide-'+(i+1)+'.png';await fsp.writeFile(path.join(outDir,name),bytes);files.push({slide:i+1,file:name});
    }
    if(payload.slide_count!==files.length) throw apiError('RENDER_FAILED','远端预览页数不完整');
    return {engine,engine_version:payload.report?.engine_version || health[engine]?.version || null,source_sha256:await sha256File(source),pages:files.length,files,warnings:[],visual_review:'pending',duration_ms:Date.now()-started,created_at:nowIso()};
  });
}
