export const GAME = 'warplex-ae';
export const CHUNK_SIZE = 5 * 1024 * 1024;
export const VERIFY_SIZE = 256 * 1024;
export const fail = (status, message) => { throw Object.assign(new Error(message), {status}); };
export const uuidPattern = /^[0-9a-f-]{36}$/;
export const versionPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const hashPattern = /^[0-9a-f]{64}$/;
export function validateRelease(input) {
  if (!input || input.gameId !== GAME || !versionPattern.test(input.version ?? '')) fail(400,'Invalid game or release version.');
  if (!hashPattern.test(input.sha256 ?? '') || !Number.isSafeInteger(input.size) || input.size < 4 || input.size > 1024 ** 3) fail(400,'Invalid archive size or checksum.');
  if (!Number.isSafeInteger(input.unpackedBytes) || input.unpackedBytes < 1 || input.unpackedBytes > 60 * 1024 ** 3) fail(400,'Invalid expanded size.');
  const exe=input.executable;
  if(typeof exe !== 'string' || exe.length > 240 || !exe.toLowerCase().endsWith('.exe') || exe.includes('\\') || exe.includes(':') || exe.startsWith('/')) fail(400,'Invalid executable.');
  for(const part of exe.split('/')) if(!part || part === '.' || part === '..' || /[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part) || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i.test(part)) fail(400,'Invalid executable path.');
  if(typeof input.notes !== 'string' || input.notes.length > 12000) fail(400,'Patch notes must be text up to 12000 characters.');
  return {gameId:GAME,version:input.version,size:input.size,sha256:input.sha256,unpackedBytes:input.unpackedBytes,executable:exe,notes:input.notes};
}
