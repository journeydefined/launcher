import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { publish } from '../../service/owner-client.mjs';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const compiled=await build({entryPoints:['cloudflare/worker.mjs'],bundle:true,format:'esm',platform:'browser',write:false,loader:{'.sql':'text'}});
const script=compiled.outputFiles[0].text;
const options={modules:true,script,compatibilityDate:'2026-09-01',d1Databases:{DB:'launcher-test'},r2Buckets:{BUILDS:'jdc-game-builds'}};
const key=randomBytes(32).toString('base64url');

await test('Worker fails closed without the owner secret',async()=>{
  const mf=new Miniflare(convertV4MiniflareOptions(options));
  try{
    for(const path of ['/health','/admin/bootstrap','/v1/games/warplex-ae/release']){
      const response=await mf.dispatchFetch(`https://launcher.example${path}`,{method:path==='/admin/bootstrap'?'POST':'GET'});assert.equal(response.status,503);await response.text();
    }
  }finally{await mf.dispose();}
});
await test('D1 and R2 private release workflow in workerd',async t=>{
  const mf=new Miniflare(convertV4MiniflareOptions({...options,bindings:{OWNER_TOKEN:key}}));
  const dir=await mkdtemp(join(tmpdir(),'launcher-worker-'));
  const db=await mf.getD1Database('DB'),bucket=await mf.getR2Bucket('BUILDS');
  async function call(method,path,body,token=key,headers={}){
    const bytes=body===undefined?undefined:Buffer.isBuffer(body)?body:Buffer.from(JSON.stringify(body));
    return mf.dispatchFetch(`https://launcher.example${path}`,{method,headers:{...(token?{Authorization:`Bearer ${token}`} : {}),...(bytes?{'Content-Length':String(bytes.length),'Content-Type':'application/json'}:{}),...headers},body:bytes});
  }
  async function api(method,path,body,headers={}){const response=await call(method,path,body,key,headers);const result=await response.json();if(response.status>=300)throw Object.assign(new Error(result.error),{status:response.status});return result;}
  let invitation;
  const bytes=Buffer.concat([Buffer.from([80,75,3,4]),randomBytes(5*1024*1024+137)]);
  const manifest={gameId:'warplex-ae',version:'worker-1',archive:'game.zip',size:bytes.length,sha256:hash(bytes),unpackedBytes:bytes.length,executable:'WarplexAE.exe',notes:'Worker integration fixture'};
  try{
    await t.test('migration is explicit, authenticated, idempotent and required',async()=>{
      assert.equal((await call('GET','/admin/testers')).status,503);
      assert.equal((await call('POST','/admin/bootstrap',undefined,randomBytes(32).toString('base64url'))).status,401);
      assert.equal((await api('POST','/admin/bootstrap')).ready,true);
      assert.equal((await api('POST','/admin/bootstrap')).schemaVersion,1);
      assert.equal((await call('GET','/health',undefined,null)).status,200);
    });
    await t.test('tester keys are hashed and cannot call owner routes',async()=>{
      invitation=await api('POST','/admin/testers',{name:'Worker tester',days:1});
      assert.equal((await db.prepare('SELECT token_hash FROM testers WHERE id=?').bind(invitation.testerId).first()).token_hash,hash(invitation.token));
      assert.equal((await call('GET','/admin/testers',undefined,invitation.token)).status,401);
      assert.equal((await call('GET','/v1/access',undefined,invitation.token)).status,200);
      await api('POST','/admin/bootstrap');assert.equal((await api('GET','/admin/testers')).length,1);
    });
    await t.test('anonymous archive/manifest access and invalid metadata are denied',async()=>{
      for(const path of ['/v1/games/warplex-ae/release','/v1/games/warplex-ae/releases/worker-1/archive'])assert.equal((await call('GET',path,undefined,null)).status,401);
      await assert.rejects(api('POST','/admin/releases',{...manifest,executable:'../bad.exe'}),e=>e.status===400);
      await assert.rejects(api('POST','/admin/releases',{...manifest,size:1024**3+1}),e=>e.status===400);
    });
    await t.test('parts enforce checksum, exact size and cross-isolate D1 leases',async()=>{
      const upload=await api('POST','/admin/releases',manifest);const part=bytes.subarray(0,upload.chunkSize);
      await assert.rejects(api('PUT',`/admin/uploads/${upload.id}`,part,{'Content-Range':`bytes 0-${part.length-1}/${bytes.length}`,'X-Chunk-SHA256':'0'.repeat(64)}),e=>e.status===400);
      assert.equal((await api('GET',`/admin/uploads/${upload.id}`)).offset,0);
      await db.prepare('UPDATE uploads SET lock_token=?,lock_until=? WHERE id=?').bind('other-worker',Date.now()+60000,upload.id).run();
      await assert.rejects(api('PUT',`/admin/uploads/${upload.id}`,part,{'Content-Range':`bytes 0-${part.length-1}/${bytes.length}`,'X-Chunk-SHA256':hash(part)}),e=>e.status===409);
      await db.prepare('UPDATE uploads SET lock_until=0 WHERE id=?').bind(upload.id).run();
      await api('PUT',`/admin/uploads/${upload.id}`,part,{'Content-Range':`bytes 0-${part.length-1}/${bytes.length}`,'X-Chunk-SHA256':hash(part)});
      assert.equal((await api('GET',`/admin/uploads/${upload.id}`)).offset,part.length);
    });
    await t.test('existing owner publisher resumes parts and bounded full SHA verification',async()=>{
      await writeFile(join(dir,'game.zip'),bytes);await writeFile(join(dir,'release.json'),JSON.stringify(manifest));
      let steps=0;const result=await publish({api,manifestPath:join(dir,'release.json'),onVerification:()=>steps++});
      assert.equal(result.verified,true);assert.ok(steps>1);
      const row=await db.prepare('SELECT * FROM uploads WHERE version=?').bind(manifest.version).first();
      assert.equal(row.status,'verified');assert.equal(row.verify_offset,bytes.length);
      assert.equal((await call('GET','/v1/games/warplex-ae/releases/worker-1/archive',undefined,invitation.token)).status,404);
      assert.equal((await api('POST',`/admin/uploads/${row.id}/complete`)).verified,true);
      await assert.rejects(api('DELETE',`/admin/uploads/${row.id}`),e=>e.status===409);
    });
    await t.test('activation enables authenticated streaming and ranges; versions stay immutable',async()=>{
      await api('PUT','/admin/channel',{version:'worker-1'});
      const response=await call('GET','/v1/games/warplex-ae/release',undefined,invitation.token);const release=await response.json();assert.equal(response.headers.get('cache-control'),'no-store');
      const archive=await call('GET',new URL(release.archive).pathname,undefined,invitation.token);assert.equal(archive.status,200);assert.equal(hash(Buffer.from(await archive.arrayBuffer())),manifest.sha256);
      const range=await call('GET',new URL(release.archive).pathname,undefined,invitation.token,{Range:'bytes=2-9'});assert.equal(range.status,206);assert.deepEqual(Buffer.from(await range.arrayBuffer()),bytes.subarray(2,10));
      assert.equal((await call('GET',new URL(release.archive).pathname,undefined,invitation.token,{Range:'bytes=999999999-'})).status,416);
      await assert.rejects(api('POST','/admin/releases',manifest),e=>e.status===409);
    });
    await t.test('full digest mismatch preserves the active release',async()=>{
      const small=bytes.subarray(0,17);const bad={...manifest,version:'bad-hash',size:small.length,sha256:'0'.repeat(64)};
      const u=await api('POST','/admin/releases',bad);
      await api('PUT',`/admin/uploads/${u.id}`,small,{'Content-Range':`bytes 0-${small.length-1}/${small.length}`,'X-Chunk-SHA256':hash(small)});
      await assert.rejects(api('POST',`/admin/uploads/${u.id}/complete`),e=>e.status===400);
      assert.equal((await api('GET','/admin/releases')).active,'worker-1');
      await assert.rejects(api('PUT','/admin/channel',{version:'bad-hash'}),e=>e.status===404);
      await api('DELETE',`/admin/uploads/${u.id}`);
    });
    await t.test('R2 completion and verification can recover after a lost response',async()=>{
      const small=bytes.subarray(0,65);const m={...manifest,version:'recovery',size:small.length,sha256:hash(small)};
      const u=await api('POST','/admin/releases',m);
      await api('PUT',`/admin/uploads/${u.id}`,small,{'Content-Range':`bytes 0-${small.length-1}/${small.length}`,'X-Chunk-SHA256':hash(small)});
      const row=await db.prepare('SELECT * FROM uploads WHERE id=?').bind(u.id).first();const parts=(await db.prepare('SELECT part_number,etag FROM parts WHERE upload_id=?').bind(u.id).all()).results;
      await bucket.resumeMultipartUpload(row.object_key,row.multipart_id).complete(parts.map(p=>({partNumber:p.part_number,etag:p.etag})));
      assert.equal((await api('POST',`/admin/uploads/${u.id}/complete`)).verified,true);
      await api('PUT','/admin/channel',{version:'recovery'});await api('PUT','/admin/channel',{version:'worker-1'});
    });
    await t.test('expiry and revocation protect subsequent downloads',async()=>{
      await db.prepare('UPDATE testers SET expires=1 WHERE id=?').bind(invitation.testerId).run();assert.equal((await call('GET','/v1/access',undefined,invitation.token)).status,401);
      invitation=await api('POST','/admin/testers',{name:'Revoke test',days:1});await api('DELETE',`/admin/testers/${invitation.testerId}`);
      assert.equal((await call('GET','/v1/games/warplex-ae/releases/worker-1/archive',undefined,invitation.token)).status,401);
    });
    await t.test('an overwritten R2 object is never served as the verified release',async()=>{
      invitation=await api('POST','/admin/testers',{name:'Integrity test',days:1});const row=await db.prepare('SELECT * FROM releases WHERE version=?').bind('worker-1').first();
      await bucket.put(row.object_key,'replaced object');assert.equal((await call('GET','/v1/games/warplex-ae/releases/worker-1/archive',undefined,invitation.token)).status,503);
      assert.equal(JSON.stringify(await api('GET','/admin/audit')).includes(invitation.token),false);
    });
  }finally{await mf.dispose();await rm(dir,{recursive:true,force:true});}
});
