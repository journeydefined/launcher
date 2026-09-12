import { request as httpsRequest } from 'node:https';
import { readFile, open, stat, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { validateRelease, hashFile } from './service.mjs';

export function client({ url, key, ca }) {
  const base = new URL(url);
  if (base.protocol !== 'https:' || base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw new Error('Owner service URL must be an HTTPS origin.');
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(key)) throw new Error('Invalid owner key file.');
  return async (method, path, input, headers = {}) => {
    const target = new URL(path, base); if(target.origin !== base.origin) throw new Error("Owner credentials cannot be sent to another origin.");
    const bytes = input === undefined ? null : Buffer.isBuffer(input) ? input : Buffer.from(JSON.stringify(input));
    return new Promise((resolveResult, reject) => {
      const req = httpsRequest(target, { method, ca, headers: { Authorization: `Bearer ${key}`, ...(bytes ? { 'Content-Type': 'application/json', 'Content-Length': bytes.length } : {}), ...headers } }, res => {
        let size = 0; const chunks = [];
        res.on('data', chunk => { size += chunk.length; if(size > 1024 * 1024) { res.destroy(new Error('Service response too large.')); return; } chunks.push(chunk); });
        res.on('error', reject);
        res.on('end', () => { let result; try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return reject(new Error('Service returned an invalid response.')); }
          if(res.statusCode >= 300) return reject(Object.assign(new Error(result.error ?? `Service request failed (${res.statusCode}).`), { status: res.statusCode }));
          resolveResult(result);
        });
      });
      req.setTimeout(120000, () => req.destroy(new Error('Service request timed out.'))); req.on('error', reject); req.end(bytes);
    });
  };
}
export async function publish({ api, manifestPath, activate = false, onProgress = () => {} }) {
  const input = JSON.parse((await readFile(manifestPath, 'utf8')).replace(/^\uFEFF/, ''));
  const manifest = validateRelease(input);
  if(typeof input.archive !== 'string' || input.archive.includes('://')) throw new Error('Publish a local ZIP archive.');
  const archive = resolve(dirname(manifestPath), input.archive);
  if((await stat(archive)).size !== manifest.size || await hashFile(archive) !== manifest.sha256) throw new Error('Local package does not match its manifest.');
  const sessions = await api('GET', '/admin/uploads');
  let upload = sessions.find(item => item.version === manifest.version);
  upload = upload ? await api('GET', `/admin/uploads/${upload.id}`) : await api('POST', '/admin/releases', manifest);
  if(upload.sha256 && upload.sha256 !== manifest.sha256) throw new Error('An upload with different content uses this version.');
  const file = await open(archive, 'r');
  try {
    let failures = 0;
    while(upload.offset < manifest.size) {
      const length = Math.min(upload.chunkSize, manifest.size - upload.offset), buffer = Buffer.alloc(length);
      const { bytesRead } = await file.read(buffer, 0, length, upload.offset); if(bytesRead !== length) throw new Error('The local archive changed during publishing.');
      try {
        const next = await api('PUT', `/admin/uploads/${upload.id}`, buffer, { 'Content-Type': 'application/octet-stream', 'Content-Range': `bytes ${upload.offset}-${upload.offset + length - 1}/${manifest.size}`, 'X-Chunk-SHA256': createHash('sha256').update(buffer).digest('hex') });
        if(next.offset !== upload.offset + length) throw new Error('Invalid upload progress response.');
        upload.offset = next.offset; failures = 0; onProgress(upload.offset, manifest.size);
      } catch(error) {
        if(++failures >= 3 || (error.status && ![409,429,500,502,503,504].includes(error.status))) throw error;
        await new Promise(resolveDelay => setTimeout(resolveDelay, failures * 1000));
        upload = await api('GET', `/admin/uploads/${upload.id}`);
      }
    }
  } finally { await file.close(); }
  const result = await api('POST', `/admin/uploads/${upload.id}/complete`);
  if(activate) await api('PUT', '/admin/channel', { version: manifest.version });
  return { ...result, active: activate };
}
export async function saveInvitation(path, invitation) {
  await mkdir(dirname(resolve(path)), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(invitation, null, 2), { flag: 'wx', mode: 0o600 });
}
