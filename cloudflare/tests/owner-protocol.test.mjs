import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {publish} from '../../service/owner-client.mjs';
test('publisher bounds retries for invalid verification responses',async()=>{
 const root=await mkdtemp(join(tmpdir(),'publisher-protocol-'));
 try{
  const bytes=Buffer.from([80,75,3,4,9]);await writeFile(join(root,'game.zip'),bytes);
  await writeFile(join(root,'game.json'),JSON.stringify({gameId:'warplex-ae',version:'invalid-protocol',archive:'game.zip',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),unpackedBytes:5,executable:'game.exe',notes:''}));
  let completions=0;
  const api=async(method,path)=>{
   if(method==='GET')return [];
   if(path==='/admin/releases')return {id:'test',offset:0,chunkSize:5};
   if(method==='PUT')return {offset:5};
   completions++;return {verified:false,status:'unexpected'};
  };
  await assert.rejects(publish({api,manifestPath:join(root,'game.json')}),/Invalid verification/);
  assert.equal(completions,3);
 }finally{await rm(root,{recursive:true,force:true});}
});
