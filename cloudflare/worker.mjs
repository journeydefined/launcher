import schema from '../migrations/0001_cloudflare.sql';
import { restoreHash, saveHash, hex } from './hash-state.mjs';
import { GAME, CHUNK_SIZE, VERIFY_SIZE, fail, uuidPattern, hashPattern, validateRelease } from './validation.mjs';

const tokenPattern=/^[A-Za-z0-9_-]{43,128}$/;
const denied=new Map();
const headers={ 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'no-referrer', 'Strict-Transport-Security':'max-age=31536000' };
const reply=(value,status=200,extra={})=>new Response(JSON.stringify(value),{status,headers:{...headers,'Content-Type':'application/json',...extra}});
const digest=async value=>hex(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)));
const same=(a,b)=>{ let different=a.length^b.length; for(let i=0;i<a.length;i++)different|=a.charCodeAt(i)^(b.charCodeAt(i)??0); return different===0; };
const statement=(env,sql,...values)=>env.DB.prepare(sql).bind(...values);
const audit=(env,action,subject)=>statement(env,'INSERT INTO audit(time,action,subject) VALUES(?,?,?)',Date.now(),action,subject);
const originOf=(req,env)=>{
  const origin=new URL(env.PUBLIC_ORIGIN || new URL(req.url).origin);
  if(origin.protocol!=='https:' || origin.username || origin.password || origin.pathname!=='/' || origin.search || origin.hash) fail(503,'Configure a secure public origin.');
  return origin.origin;
};
async function readJson(req) {
  if(Number(req.headers.get('content-length'))>65536) fail(413,'Request is too large.');
  const reader=req.body?.getReader(); if(!reader)fail(400,'A JSON body is required.');
  const chunks=[];let total=0;
  try { while(true){const {done,value}=await reader.read();if(done)break;total+=value.length;if(total>65536){await reader.cancel();fail(413,'Request is too large.');}chunks.push(value);} }
  finally {reader.releaseLock();}
  const bytes=new Uint8Array(total);let at=0;for(const part of chunks){bytes.set(part,at);at+=part.length;}
  try{return JSON.parse(new TextDecoder().decode(bytes));}catch{fail(400,'Invalid JSON.');}
}
async function ready(env) {
  try {return (await statement(env,'SELECT version FROM launcher_schema WHERE id=1').first())?.version===1;} catch{return false;}
}
async function authenticate(req,env,owner) {
  const token=/^Bearer ([A-Za-z0-9_-]{43,128})$/.exec(req.headers.get('authorization')??'')?.[1];
  let tester;
  const hashed=await digest(token??'');
  const allowed=owner ? !!token && same(hashed,await digest(env.OWNER_TOKEN)) : !!token && (tester=await statement(env,'SELECT id,expires,revoked FROM testers WHERE token_hash=?',hashed).first()) && !tester.revoked && tester.expires>Date.now();
  if(!allowed){
    const address=req.headers.get('CF-Connecting-IP')??'local';let bucket=denied.get(address);
    if(!bucket || bucket.until<Date.now())bucket={count:0,until:Date.now()+60000};bucket.count++;
    if(denied.size>10000)denied.clear();denied.set(address,bucket);
    fail(bucket.count>60?429:401,bucket.count>60?'Too many denied requests. Try again shortly.':'Access denied. Check your invitation or contact the game owner.');
  }
  return tester;
}
async function uploadRow(env,id,allowExpired=false) {
  if(!uuidPattern.test(id))fail(404,'Upload not found.');
  const row=await statement(env,'SELECT * FROM uploads WHERE id=?',id).first();
  if(!row || (!allowExpired && row.status!=='verified' && row.created<Date.now()-86400000))fail(404,'Upload expired or not found.');
  return row;
}
async function locked(env,id,callback,allowExpired=false) {
  await uploadRow(env,id,allowExpired);
  const lease=crypto.randomUUID();
  const row=await statement(env,'UPDATE uploads SET lock_token=?,lock_until=? WHERE id=? AND (lock_token IS NULL OR lock_until<?) RETURNING *',lease,Date.now()+120000,id,Date.now()).first();
  if(!row)fail(409,'Upload is busy. Retry after its current operation completes.');
  try{return await callback(row,lease);}finally{await statement(env,'UPDATE uploads SET lock_token=NULL,lock_until=0 WHERE id=? AND lock_token=?',id,lease).run();}
}
function uploadInfo(row){const m=JSON.parse(row.manifest);return {id:row.id,version:row.version,offset:row.offset,size:m.size,sha256:m.sha256,chunkSize:CHUNK_SIZE,status:row.status,verifiedBytes:row.verify_offset};}

async function receivePart(req,env,row,lease) {
  if(row.status!=='receiving')fail(409,'Upload no longer accepts parts.');
  const manifest=JSON.parse(row.manifest);
  const range=/^bytes (\d+)-(\d+)\/(\d+)$/.exec(req.headers.get('content-range')??'');
  if(!range || +range[1]!==row.offset || +range[3]!==manifest.size || +range[2]<+range[1] || +range[2]>=manifest.size)fail(409,'Upload offset or total does not match. Query progress and retry.');
  const length=+range[2]-+range[1]+1;
  if(length!==Math.min(CHUNK_SIZE,manifest.size-row.offset) || Number(req.headers.get('content-length'))!==length || !req.body)fail(400,'Use the advertised chunk size and exact Content-Length.');
  const expected=req.headers.get('x-chunk-sha256');if(!hashPattern.test(expected??''))fail(400,'Chunk SHA-256 is required.');
  const streamHash=new crypto.DigestStream('SHA-256'); const hashWriter=streamHash.getWriter();
  // Avoid a rejected digest promise becoming unhandled when the input is aborted.
  streamHash.digest.catch(()=>{});
  let count=0;const signature=[];
  const checked=new TransformStream({
    async transform(chunk,controller){
      count+=chunk.length;if(count>length)fail(400,'Chunk exceeds its declared size.');
      if(row.offset===0 && signature.length<4)for(const b of chunk){if(signature.length===4)break;signature.push(b);}
      await hashWriter.write(chunk);controller.enqueue(chunk);
    },
    async flush(){
      await hashWriter.close();
      if(count!==length || hex(await streamHash.digest)!==expected)fail(400,'Chunk size or checksum mismatch.');
      if(row.offset===0 && signature.join(',')!=='80,75,3,4')fail(400,'Release must be a ZIP archive.');
    }
  });
  const fixed=new FixedLengthStream(length);
  const pumping=req.body.pipeThrough(checked).pipeTo(fixed.writable);
  const multipart=env.BUILDS.resumeMultipartUpload(row.object_key,row.multipart_id);
  let part;
  try { [part]=await Promise.all([multipart.uploadPart(Math.floor(row.offset/CHUNK_SIZE)+1,fixed.readable),pumping]); }
  catch(error){await hashWriter.abort().catch(()=>{});if(error.status)throw error;fail(400,'Chunk transfer failed. Query progress and retry.');}
  const results=await env.DB.batch([
    statement(env,'INSERT INTO parts(upload_id,part_number,etag,sha256,size) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM uploads WHERE id=? AND lock_token=? AND offset=?) ON CONFLICT(upload_id,part_number) DO UPDATE SET etag=excluded.etag,sha256=excluded.sha256,size=excluded.size',row.id,part.partNumber,part.etag,expected,length,row.id,lease,row.offset),
    statement(env,'UPDATE uploads SET offset=? WHERE id=? AND lock_token=? AND offset=?',row.offset+length,row.id,lease,row.offset)
  ]);
  if(results[1].meta.changes!==1)fail(409,'Upload lease changed. Query progress before retrying.');
  return reply({id:row.id,offset:row.offset+length});
}
async function complete(env,row,lease) {
  const manifest=JSON.parse(row.manifest);
  if(row.status==='verified')return reply({version:row.version,verified:true,active:false});
  if(row.status==='failed')fail(400,'Archive verification failed. Discard this upload and use a new upload.');
  if(row.offset!==manifest.size)fail(409,'Upload is incomplete.');
  if(row.status==='receiving') {
    // HEAD recovers a successful R2 completion whose D1 transition/response was interrupted.
    let object=await env.BUILDS.head(row.object_key);
    if(!object){
      const parts=(await statement(env,'SELECT part_number,etag FROM parts WHERE upload_id=? ORDER BY part_number',row.id).all()).results;
      if(parts.length!==Math.ceil(manifest.size/CHUNK_SIZE))fail(409,'Upload parts are incomplete.');
      object=await env.BUILDS.resumeMultipartUpload(row.object_key,row.multipart_id).complete(parts.map(p=>({partNumber:p.part_number,etag:p.etag})));
    }
    if(object.size!==manifest.size || object.customMetadata?.upload!==row.id)fail(409,'Stored archive metadata does not match.');
    const changed=await statement(env,"UPDATE uploads SET status='verifying',etag=?,verify_offset=0,hash_state=NULL WHERE id=? AND lock_token=?",object.etag,row.id,lease).run();
    if(changed.meta.changes!==1)fail(409,'Upload lease changed.');
    row={...row,status:'verifying',etag:object.etag,verify_offset:0,hash_state:null};
  }
  const length=Math.min(VERIFY_SIZE,manifest.size-row.verify_offset);
  const object=await env.BUILDS.get(row.object_key,{range:{offset:row.verify_offset,length},onlyIf:{etagMatches:row.etag}});
  if(!object?.body)fail(409,'Archive changed or is missing. Verification cannot continue.');
  const bytes=new Uint8Array(await object.arrayBuffer());if(bytes.length!==length)fail(409,'Archive verification read was incomplete.');
  const hash=restoreHash(row.hash_state,row.verify_offset);hash.update(bytes);
  const next=row.verify_offset+length;
  if(next<manifest.size){
    const changed=await statement(env,'UPDATE uploads SET hash_state=?,verify_offset=? WHERE id=? AND lock_token=? AND verify_offset=?',saveHash(hash),next,row.id,lease,row.verify_offset).run();
    if(changed.meta.changes!==1)fail(409,'Verification lease changed. Retry.');
    return reply({id:row.id,version:row.version,verified:false,status:'verifying',verifiedBytes:next,size:manifest.size},202);
  }
  if(hex(hash.digest())!==manifest.sha256){
    await statement(env,"UPDATE uploads SET status='failed' WHERE id=? AND lock_token=?",row.id,lease).run();
    fail(400,'Archive SHA-256 mismatch. The active release is unchanged.');
  }
  const result=await env.DB.batch([
    statement(env,"INSERT INTO releases(version,manifest,object_key,etag,created) SELECT version,manifest,object_key,etag,? FROM uploads WHERE id=? AND lock_token=? AND status='verifying'",Date.now(),row.id,lease),
    statement(env,"UPDATE uploads SET status='verified',verify_offset=?,hash_state=NULL WHERE id=? AND lock_token=?",next,row.id,lease),
    audit(env,'release-verified',row.version)
  ]);
  if(result[0].meta.changes!==1)fail(409,'Verification lease changed. Retry.');
  return reply({version:row.version,verified:true,active:false},201);
}

async function route(req,env) {
  const url=new URL(req.url),path=url.pathname,method=req.method;
  if(url.search)fail(400,'Query parameters are not accepted.');
  const configured=tokenPattern.test(env.OWNER_TOKEN??'') && !!env.DB && !!env.BUILDS;
  if(path==='/health' && method==='GET'){
    const schemaReady=!!env.DB && await ready(env);
    return reply({status:configured&&schemaReady?'ok':'setup-required',ownerSecret:tokenPattern.test(env.OWNER_TOKEN??''),schemaReady},configured&&schemaReady?200:503);
  }
  if(!configured)fail(503,'Private service setup is incomplete.');
  if(path==='/admin/bootstrap' && method==='POST'){
    await authenticate(req,env,true);
    // Explicit owner action only, idempotent and non-destructive. No migration on public requests.
    await env.DB.exec(schema);
    if(!await ready(env))fail(503,'Database setup did not complete.');
    return reply({schemaVersion:1,ready:true});
  }
  if(!await ready(env))fail(503,'Database migration is required.');
  if(path.startsWith('/admin/')){
    await authenticate(req,env,true);
    if(path==='/admin/testers' && method==='POST'){
      const {name,days=30}=await readJson(req);
      if(typeof name!=='string' || !name.trim() || name.length>100 || !Number.isInteger(days) || days<1 || days>90)fail(400,'Supply a tester label and 1–90 access days.');
      const token=btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
      const id=crypto.randomUUID(),expires=Date.now()+days*86400000;
      await env.DB.batch([statement(env,'INSERT INTO testers(id,name,token_hash,expires,created) VALUES(?,?,?,?,?)',id,name.trim(),await digest(token),expires,Date.now()),audit(env,'tester-issued',id)]);
      return reply({schema:1,gameId:GAME,testerId:id,name:name.trim(),expires,feed:`${originOf(req,env)}/v1/games/${GAME}/release`,token},201);
    }
    if(path==='/admin/testers' && method==='GET')return reply((await statement(env,'SELECT id,name,expires,revoked,created FROM testers ORDER BY created DESC LIMIT 1000').all()).results);
    const tester=/^\/admin\/testers\/([0-9a-f-]{36})$/.exec(path);
    if(tester && method==='DELETE'){
      const result=await env.DB.batch([statement(env,'UPDATE testers SET revoked=1 WHERE id=?',tester[1]),audit(env,'tester-revoked',tester[1])]);
      if(!result[0].meta.changes)fail(404,'Tester not found.');return reply({revoked:true});
    }
    if(path==='/admin/releases' && method==='GET')return reply({active:(await statement(env,'SELECT version FROM channel WHERE id=1').first())?.version??null,releases:(await statement(env,'SELECT version,created,published FROM releases ORDER BY created DESC LIMIT 1000').all()).results});
    if(path==='/admin/releases' && method==='POST'){
      const manifest=validateRelease(await readJson(req));
      if(await statement(env,'SELECT 1 FROM uploads WHERE version=?',manifest.version).first() || await statement(env,'SELECT 1 FROM releases WHERE version=?',manifest.version).first())fail(409,'Version already exists. Resume its upload or select a new version.');
      if((await statement(env,"SELECT count(*) AS count FROM uploads WHERE status!='verified'").first()).count>=20)fail(409,'Remove abandoned uploads before creating more.');
      const id=crypto.randomUUID(),key=`launcher/warplex-ae/${id}.zip`;
      const multipart=await env.BUILDS.createMultipartUpload(key,{httpMetadata:{contentType:'application/zip',cacheControl:'no-store'},customMetadata:{upload:id}});
      try{await env.DB.batch([statement(env,'INSERT INTO uploads(id,version,manifest,object_key,multipart_id,created) VALUES(?,?,?,?,?,?)',id,manifest.version,JSON.stringify(manifest),key,multipart.uploadId,Date.now()),audit(env,'upload-created',id)]);}
      catch{await multipart.abort();fail(409,'The version was reserved by another upload, or the database could not save it.');}
      return reply({id,offset:0,chunkSize:CHUNK_SIZE},201);
    }
    if(path==='/admin/uploads' && method==='GET')return reply((await statement(env,"SELECT id,version,offset,status,verify_offset AS verifiedBytes,created FROM uploads WHERE status!='verified' ORDER BY created DESC LIMIT 1000").all()).results);
    const upload=/^\/admin\/uploads\/([0-9a-f-]{36})(\/complete)?$/.exec(path);
    if(upload){
      const id=upload[1];
      if(method==='GET' && !upload[2])return reply(uploadInfo(await uploadRow(env,id)));
      if(method==='PUT' && !upload[2])return locked(env,id,(row,lease)=>receivePart(req,env,row,lease));
      if(method==='POST' && upload[2])return locked(env,id,(row,lease)=>complete(env,row,lease));
      if(method==='DELETE' && !upload[2])return locked(env,id,async row=>{
        if(row.status==='verified')fail(409,'Verified releases cannot be deleted through upload cleanup.');
        await env.BUILDS.resumeMultipartUpload(row.object_key,row.multipart_id).abort().catch(()=>{});
        await env.BUILDS.delete(row.object_key);
        await env.DB.batch([statement(env,'DELETE FROM parts WHERE upload_id=?',id),statement(env,'DELETE FROM uploads WHERE id=?',id),audit(env,'upload-removed',id)]);
        return reply({removed:true});
      },true);
    }
    if(path==='/admin/channel' && method==='PUT'){
      const {version}=await readJson(req);
      if(typeof version!=='string' || !await statement(env,'SELECT 1 FROM releases WHERE version=?',version).first())fail(404,'Verified release not found.');
      await env.DB.batch([statement(env,'UPDATE releases SET published=1 WHERE version=?',version),statement(env,'INSERT INTO channel(id,version) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version',version),audit(env,'channel-activated',version)]);
      return reply({active:version});
    }
    if(path==='/admin/audit' && method==='GET')return reply((await statement(env,'SELECT time,action,subject FROM audit ORDER BY id DESC LIMIT 100').all()).results);
    fail(404,'Owner operation not found.');
  }
  const tester=await authenticate(req,env,false);
  if(path==='/v1/access' && method==='GET')return reply({gameId:GAME,expires:tester.expires});
  if(path===`/v1/games/${GAME}/release` && method==='GET'){
    const row=await statement(env,'SELECT manifest FROM releases JOIN channel ON releases.version=channel.version WHERE channel.id=1 AND published=1').first();
    if(!row)fail(404,'No release is available yet.');const manifest=JSON.parse(row.manifest);
    return reply({...manifest,archive:`${originOf(req,env)}/v1/games/${GAME}/releases/${manifest.version}/archive`});
  }
  const archive=/^\/v1\/games\/warplex-ae\/releases\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})\/archive$/.exec(path);
  if(archive && (method==='GET' || method==='HEAD')){
    const row=await statement(env,'SELECT * FROM releases WHERE version=? AND published=1',archive[1]).first();if(!row)fail(404,'Release not found.');
    const manifest=JSON.parse(row.manifest),size=manifest.size;let start=0,end=size-1,status=200;
    const out={...headers,'Content-Type':'application/zip','Accept-Ranges':'bytes','ETag':`"${manifest.sha256}"`};
    if(req.headers.has('range')){
      const range=/^bytes=(\d+)-(\d*)$/.exec(req.headers.get('range'));
      if(!range || +range[1]>=size || (range[2] && (+range[2]<+range[1] || +range[2]>=size)))return reply({error:'Invalid byte range.'},416,{'Content-Range':`bytes */${size}`});
      start=+range[1];end=range[2]?+range[2]:end;status=206;out['Content-Range']=`bytes ${start}-${end}/${size}`;
    }
    out['Content-Length']=String(end-start+1);
    const object=method==='HEAD'?await env.BUILDS.head(row.object_key):await env.BUILDS.get(row.object_key,{range:{offset:start,length:end-start+1},onlyIf:{etagMatches:row.etag}});
    if(!object || object.etag!==row.etag || (method==='GET' && !object.body))fail(503,'The verified archive is unavailable.');
    return new Response(method==='HEAD'?null:object.body,{status,headers:out});
  }
  fail(404,'Not found.');
}
export default {
  async fetch(req,env){
    try{return await route(req,env);}
    catch(error){
      // Finish a bounded rejected part before returning 409/400, so HTTP clients can
      // read the retry response rather than seeing an upload-side connection reset.
      if([400,409].includes(error.status) && req.body && !req.bodyUsed && Number(req.headers.get('content-length'))<=CHUNK_SIZE){
        const reader=req.body.getReader();let bytes=0;
        try{while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.length;if(bytes>CHUNK_SIZE){await reader.cancel();break;}}}catch{}finally{reader.releaseLock();}
      }
      return reply({error:error.status?error.message:'The service could not complete this request.'},error.status??500);
    }
  }
};
