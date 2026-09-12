import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:https';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes, createHash } from 'node:crypto';
import { createService, CHUNK_SIZE } from '../service.mjs';
import { client, publish, saveInvitation } from '../owner-client.mjs';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

await test('Private distribution over verified local TLS', async t => {
  const root = await mkdtemp(join(tmpdir(),'journey-service-test-'));
  const key = randomBytes(32).toString('base64url');
  const cert = await readFile(process.env.TEST_TLS_CERT), tlsKey = await readFile(process.env.TEST_TLS_KEY);
  let now=Date.now();
  const service=await createService({dataDir:join(root,'data'),adminToken:key,publicOrigin:'https://localhost',now:()=>now});
  const server=createServer({cert,key:tlsKey,minVersion:'TLSv1.2'},service.handle);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url=`https://localhost:${server.address().port}`;
  const api=client({url,key,ca:cert});
  async function call(path,{token,method='GET',bytes,headers={}}={}) {
    return new Promise((resolve,reject)=>{
      const req=request(new URL(path,url),{method,ca:cert,lookup:(host,options,done)=>options.all?done(null,[{address:'127.0.0.1',family:4}]):done(null,'127.0.0.1',4),headers:{...(token?{Authorization:`Bearer ${token}`} : {}),...headers}},res=>{
        const parts=[];res.on('data',part=>parts.push(part));res.on('error',reject);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,bytes:Buffer.concat(parts)}));
      });req.on('error',reject);req.end(bytes);
    });
  }
  let invitation;
  const packageBytes=Buffer.concat([Buffer.from([80,75,3,4]),randomBytes(CHUNK_SIZE+123)]);
  const manifest={gameId:'warplex-ae',version:'test-1',archive:'game.zip',size:packageBytes.length,sha256:hash(packageBytes),unpackedBytes:packageBytes.length,executable:'WarplexAE.exe',notes:'Integration fixture.'};
  try {
    await t.test('anonymous and bad-key access is denied for manifests, archives and owner operations',async()=>{
      for(const path of ['/v1/games/warplex-ae/release','/v1/games/warplex-ae/releases/test-1/archive','/admin/testers'])assert.equal((await call(path)).status,401);
      assert.equal((await call('/admin/testers',{token:randomBytes(32).toString('base64url')})).status,401);
    });
    await t.test('owner creates expiring tester access and database stores only its hash',async()=>{
      invitation=await api('POST','/admin/testers',{name:'Integration tester',days:2});
      assert.equal(invitation.token.length,43);assert.equal(invitation.expires,now+2*86400000);
      const row=service.db.prepare('SELECT * FROM testers WHERE id=?').get(invitation.testerId);
      assert.equal(row.token_hash,hash(invitation.token));assert.equal(JSON.stringify(row).includes(invitation.token),false);
      assert.equal((await call('/admin/testers',{token:invitation.token})).status,401);
      assert.equal((await call('/v1/access',{token:invitation.token})).status,200);
    });
    await t.test('invalid release paths and fields are rejected',async()=>{
      for(const executable of ['../evil.exe','C:/evil.exe','CON.exe','game./evil.exe'])await assert.rejects(api('POST','/admin/releases',{...manifest,executable}),e=>e.status===400);
      await assert.rejects(api('POST','/admin/releases',{...manifest,size:-1}),e=>e.status===400);
    });
    await t.test('bad chunks and incorrect offsets do not advance the upload',async()=>{
      const u=await api('POST','/admin/releases',manifest);
      await assert.rejects(api('PUT',`/admin/uploads/${u.id}`,packageBytes.subarray(0,10),{'Content-Range':`bytes 0-9/${manifest.size}`,'X-Chunk-SHA256':'0'.repeat(64)}),e=>e.status===400);
      assert.equal((await api('GET',`/admin/uploads/${u.id}`)).offset,0);
      await assert.rejects(api('PUT',`/admin/uploads/${u.id}`,packageBytes.subarray(0,10),{'Content-Range':`bytes 1-10/${manifest.size}`,'X-Chunk-SHA256':hash(packageBytes.subarray(0,10))}),e=>e.status===409);
      await assert.rejects(api('POST',`/admin/uploads/${u.id}/complete`),e=>e.status===409);
      const part=packageBytes.subarray(0,CHUNK_SIZE);
      await api('PUT',`/admin/uploads/${u.id}`,part,{'Content-Range':`bytes 0-${part.length-1}/${manifest.size}`,'X-Chunk-SHA256':hash(part)});
      assert.equal((await api('GET',`/admin/uploads/${u.id}`)).offset,CHUNK_SIZE);
    });
    await t.test('publishing resumes a partial upload, verifies bytes, and stages without activating',async()=>{
      await writeFile(join(root,'game.zip'),packageBytes);await writeFile(join(root,'release.json'),JSON.stringify(manifest));
      const result=await publish({api,manifestPath:join(root,'release.json')});assert.equal(result.verified,true);assert.equal(result.active,false);
      assert.equal((await call('/v1/games/warplex-ae/release',{token:invitation.token})).status,404);
      assert.deepEqual(await readFile(join(root,'data','packages','test-1.zip')),packageBytes);
    });
    await t.test('activation exposes only the verified private release and range downloads',async()=>{
      await api('PUT','/admin/channel',{version:'test-1'});
      const response=await call('/v1/games/warplex-ae/release',{token:invitation.token});assert.equal(response.status,200);assert.equal(response.headers['cache-control'],'no-store');
      const release=JSON.parse(response.bytes);assert.equal(release.sha256,manifest.sha256);assert.equal(new URL(release.archive).protocol,'https:');
      const path=new URL(release.archive).pathname;
      assert.equal((await call(path)).status,401);
      const whole=await call(path,{token:invitation.token});assert.equal(hash(whole.bytes),manifest.sha256);
      const range=await call(path,{token:invitation.token,headers:{Range:'bytes=2-9'}});assert.equal(range.status,206);assert.deepEqual(range.bytes,packageBytes.subarray(2,10));
      assert.equal((await call(path,{token:invitation.token,headers:{Range:'bytes=999999999-'}})).status,416);
    });
    await t.test('failed archive verification preserves the active release',async()=>{
      const bad={...manifest,version:'bad-release',size:4,sha256:'0'.repeat(64)};
      const u=await api('POST','/admin/releases',bad),part=packageBytes.subarray(0,4);
      await api('PUT',`/admin/uploads/${u.id}`,part,{'Content-Range':'bytes 0-3/4','X-Chunk-SHA256':hash(part)});
      await assert.rejects(api('POST',`/admin/uploads/${u.id}/complete`),e=>e.status===400);
      assert.equal((await api('GET','/admin/releases')).active,'test-1');
      await api('DELETE',`/admin/uploads/${u.id}`);
    });
    await t.test('a later release can activate and owner can roll back without rewriting packages',async()=>{
      await writeFile(join(root,'release-2.json'),JSON.stringify({...manifest,version:'test-2'}));
      assert.equal((await publish({api,manifestPath:join(root,'release-2.json'),activate:true})).active,true);
      assert.equal((await api('GET','/admin/releases')).active,'test-2');
      await api('PUT','/admin/channel',{version:'test-1'});
      await assert.rejects(api('POST','/admin/releases',manifest),e=>e.status===409);
      assert.equal((await api('GET','/admin/releases')).active,'test-1');
    });
    await t.test('expiry and revocation deny subsequent manifests and downloads',async()=>{
      now+=3*86400000;assert.equal((await call('/v1/access',{token:invitation.token})).status,401);
      invitation=await api('POST','/admin/testers',{name:'Revocation test',days:1});
      await api('DELETE',`/admin/testers/${invitation.testerId}`);
      for(const path of ['/v1/games/warplex-ae/release','/v1/games/warplex-ae/releases/test-1/archive'])assert.equal((await call(path,{token:invitation.token})).status,401);
    });
    await t.test('invitation export is explicit and never overwrites an existing file',async()=>{
      const out=join(root,'tester.invite.json');await saveInvitation(out,invitation);await assert.rejects(saveInvitation(out,invitation),e=>e.code==='EEXIST');
      assert.equal((await readFile(out,'utf8')).includes(invitation.token),true);
      assert.equal(JSON.stringify(await api('GET','/admin/testers')).includes(invitation.token),false);
    });
    await t.test('denied-access throttling and credential-free audit records',async()=>{
      let response;for(let i=0;i<31;i++)response=await call('/v1/access');assert.equal(response.status,429);
      const audit=await api('GET','/admin/audit');assert.ok(audit.length>0);assert.equal(JSON.stringify(audit).includes(invitation.token),false);
    });
  } finally { await new Promise(resolve=>server.close(resolve));service.close();await rm(root,{recursive:true,force:true}); }
});
