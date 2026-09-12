import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {randomBytes,createHash} from 'node:crypto';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
import {publish} from '../../service/owner-client.mjs';
const compiled=await build({entryPoints:['cloudflare/worker.mjs'],bundle:true,format:'esm',platform:'browser',write:false,loader:{'.sql':'text'}});
const key=randomBytes(32).toString('base64url');
const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:compiled.outputFiles[0].text,compatibilityDate:'2026-09-01',d1Databases:{DB:'real-game-test'},r2Buckets:{BUILDS:'real-game-test'},bindings:{OWNER_TOKEN:key}}));
async function api(method,path,input,headers={}){
 const body=input===undefined?undefined:Buffer.isBuffer(input)?input:Buffer.from(JSON.stringify(input));
 const response=await mf.dispatchFetch('https://launcher.example'+path,{method,headers:{Authorization:`Bearer ${key}`,...(body?{'Content-Length':String(body.length)}:{}),...headers},body});
 const value=await response.json();if(response.status>=300)throw Object.assign(new Error(value.error),{status:response.status});return value;
}
try{
 await api('POST','/admin/bootstrap');
 let checkpoints=0;
 const result=await publish({api,manifestPath:resolve(process.argv[2]),activate:true,onVerification:()=>checkpoints++});
 const invitation=await api('POST','/admin/testers',{name:'Real package validation',days:1});
 const manifest=await (await mf.dispatchFetch(invitation.feed,{headers:{Authorization:`Bearer ${invitation.token}`}})).json();
 const response=await mf.dispatchFetch(manifest.archive,{headers:{Authorization:`Bearer ${invitation.token}`}});assert.equal(response.status,200);
 const hash=createHash('sha256');let bytes=0;
 for await(const part of response.body){hash.update(part);bytes+=part.length;}
 assert.equal(bytes,manifest.size);assert.equal(hash.digest('hex'),manifest.sha256);
 await api('DELETE',`/admin/testers/${invitation.testerId}`);
 assert.equal((await mf.dispatchFetch(manifest.archive,{headers:{Authorization:`Bearer ${invitation.token}`}})).status,401);
 console.log(`PASS: Cloudflare workerd/D1/R2 published and streamed ${result.version} (${bytes} bytes), full SHA-256 matched, ${checkpoints} resumable verification checkpoints; revocation denied the next archive request.`);
}finally{await mf.dispose();}
