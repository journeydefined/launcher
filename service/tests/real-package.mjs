import { createServer, request } from 'node:https';
import { randomBytes, createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { createService } from '../service.mjs';
import { client, publish } from '../owner-client.mjs';
const manifestPath=resolve(process.argv[2]);
const cert=await readFile(process.env.TEST_TLS_CERT),key=await readFile(process.env.TEST_TLS_KEY);
const root=await mkdtemp(join(tmpdir(),'journey-real-release-'));
const ownerKey=randomBytes(32).toString('base64url');
let service;
const server=createServer({cert,key},(req,res)=>service.handle(req,res));
await new Promise(resolveListen=>server.listen(0,'127.0.0.1',resolveListen));
const url=`https://localhost:${server.address().port}`;
service=await createService({dataDir:root,adminToken:ownerKey,publicOrigin:url});
const api=client({url,key:ownerKey,ca:cert});
try {
 const published=await publish({api,manifestPath,activate:true});
 const invitation=await api('POST','/admin/testers',{name:'Local real-package validation',days:1});
 const tester=client({url,key:invitation.token,ca:cert});
 const release=await tester('GET','/v1/games/warplex-ae/release');
 const downloaded=await new Promise((resolveDownload,reject)=>{
  const req=request(release.archive,{ca:cert,headers:{Authorization:`Bearer ${invitation.token}`}},res=>{
   if(res.statusCode!==200){res.resume();reject(new Error(`Download returned ${res.statusCode}`));return;}
   const hash=createHash('sha256');let bytes=0;
   res.on('data',part=>{hash.update(part);bytes+=part.length;});res.on('error',reject);res.on('end',()=>resolveDownload({bytes,sha256:hash.digest('hex')}));
  });req.on('error',reject);req.end();
 });
 assert.equal(downloaded.bytes,release.size);assert.equal(downloaded.sha256,release.sha256);
 await api('DELETE',`/admin/testers/${invitation.testerId}`);
 await assert.rejects(tester('GET','/v1/games/warplex-ae/release'),error=>error.status===401);
 console.log(`PASS: Real ${published.version} package published, activated and downloaded over verified HTTPS (${downloaded.bytes} bytes; SHA-256 matches); tester revocation confirmed.`);
} finally {await new Promise(resolveClose=>server.close(resolveClose));service.close();await rm(root,{recursive:true,force:true});}
