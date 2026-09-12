import { sha256 } from '@noble/hashes/sha2.js';

// Checkpoint adapter for pinned @noble/hashes 2.4.0 SHA-256 state.
// Never accept this state from an HTTP caller: it is server-generated and stored in D1.
// Upgrade the dependency only alongside the cross-boundary/native-reference tests.
export function restoreHash(serialized, expectedLength) {
  const hash = sha256.create();
  if (!serialized) { if(expectedLength !== 0) throw new Error('Missing hash checkpoint'); return hash; }
  const s = JSON.parse(serialized);
  if (s.format !== 1 || s.length !== expectedLength || s.pos !== expectedLength % 64 || s.words.length !== 8 || s.tail.length !== s.pos) throw new Error('Invalid hash checkpoint');
  if (!s.words.every(Number.isInteger) || !s.tail.every(n => Number.isInteger(n) && n >= 0 && n <= 255)) throw new Error('Invalid hash state');
  hash.set(...s.words); hash.length = s.length; hash.pos = s.pos; hash.buffer.set(s.tail);
  return hash;
}
export function saveHash(hash) {
  return JSON.stringify({format:1, words:hash.get(), length:hash.length, pos:hash.pos, tail:Array.from(hash.buffer.subarray(0,hash.pos))});
}
export const hex = bytes => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2,'0')).join('');
