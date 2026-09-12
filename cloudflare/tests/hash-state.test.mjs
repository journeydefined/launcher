import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { restoreHash, saveHash, hex } from '../hash-state.mjs';

test('SHA-256 checkpoint resumes across block boundaries and matches native SHA-256',()=>{
  const data=randomBytes(1024*1024+131);
  for(const step of [1,63,64,65,257,65536,262144]){
    // Use a shorter vector for byte-at-a-time serialization; full MiB for realistic chunks.
    const input=step<100?data.subarray(0,1027):data;
    let state=null,offset=0;
    while(offset<input.length){const hash=restoreHash(state,offset);const part=input.subarray(offset,offset+step);hash.update(part);offset+=part.length;state=saveHash(hash);}
    assert.equal(hex(restoreHash(state,offset).digest()),createHash('sha256').update(input).digest('hex'));
  }
  assert.throws(()=>restoreHash(null,64));
  const h=restoreHash(null,0);h.update(new Uint8Array([1,2]));assert.throws(()=>restoreHash(saveHash(h),3));
});
