import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink, stat, copyFile } from 'node:fs/promises';
import { createReadStream, constants } from 'node:fs';
import { resolve, join } from 'node:path';
import { pipeline } from 'node:stream/promises';

export const CHUNK_SIZE = 8 * 1024 * 1024;
export const MAX_PACKAGE = 20 * 1024 ** 3;
const GAME = 'warplex-ae';
const sha = value => createHash('sha256').update(value).digest('hex');
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const idPattern = /^[0-9a-f-]{36}$/;
const versionPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const hex = /^[0-9a-f]{64}$/;

export function validateRelease(input) {
  if (!input || input.gameId !== GAME || !versionPattern.test(input.version ?? '')) fail(400, 'Invalid game or version.');
  if (!hex.test(input.sha256 ?? '') || !Number.isSafeInteger(input.size) || input.size < 4 || input.size > MAX_PACKAGE) fail(400, 'Invalid archive size or checksum.');
  if (!Number.isSafeInteger(input.unpackedBytes) || input.unpackedBytes < 1 || input.unpackedBytes > 60 * 1024 ** 3) fail(400, 'Invalid expanded size.');
  const exe = input.executable;
  if (typeof exe !== 'string' || exe.length > 240 || !exe.toLowerCase().endsWith('.exe') || exe.includes('\\') || exe.includes(':') || exe.startsWith('/')) fail(400, 'Invalid executable.');
  for (const part of exe.split('/')) if (!part || part === '.' || part === '..' || /[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part) || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i.test(part)) fail(400, 'Invalid executable path.');
  if (typeof input.notes !== 'string' || input.notes.length > 12000) fail(400, 'Patch notes must be text up to 12000 characters.');
  return { gameId: GAME, version: input.version, size: input.size, sha256: input.sha256, unpackedBytes: input.unpackedBytes, executable: exe, notes: input.notes };
}
async function body(req, limit) {
  if (Number(req.headers['content-length']) > limit) fail(413, 'Request is too large.');
  let length = 0; const chunks = [];
  for await (const chunk of req) { length += chunk.length; if (length > limit) fail(413, 'Request is too large.'); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
async function json(req) { try { return JSON.parse((await body(req, 65536)).toString('utf8')); } catch (e) { if (e.status) throw e; fail(400, 'Invalid JSON.'); } }
function respond(res, status, value) {
  const bytes = Buffer.from(JSON.stringify(value));
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': bytes.length }); res.end(bytes);
}
export async function hashFile(path) { const h = createHash('sha256'); for await (const chunk of createReadStream(path)) h.update(chunk); return h.digest('hex'); }

export async function createService({ dataDir, adminToken, publicOrigin, now = Date.now }) {
  const origin = new URL(publicOrigin);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('PUBLIC_ORIGIN must be an HTTPS origin without a path.');
  if (typeof adminToken !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(adminToken)) throw new Error('A randomly generated owner key of at least 32 bytes is required.');
  const root = resolve(dataDir), packages = join(root, 'packages'), uploads = join(root, 'uploads');
  await mkdir(packages, { recursive: true, mode: 0o700 }); await mkdir(uploads, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(root, 'access.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS testers (id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL, expires INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS releases (version TEXT PRIMARY KEY, manifest TEXT NOT NULL, created INTEGER NOT NULL, published INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS channel (id INTEGER PRIMARY KEY CHECK(id=1), version TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS uploads (id TEXT PRIMARY KEY, version TEXT UNIQUE NOT NULL, manifest TEXT NOT NULL, offset INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, time INTEGER NOT NULL, action TEXT NOT NULL, subject TEXT NOT NULL);`);
  if (!db.prepare('PRAGMA table_info(releases)').all().some(column => column.name === 'published')) {
    db.exec('ALTER TABLE releases ADD COLUMN published INTEGER NOT NULL DEFAULT 0');
    db.exec('UPDATE releases SET published=1 WHERE version IN (SELECT version FROM channel)');
  }
  const adminHash = Buffer.from(sha(adminToken), 'hex');
  const locks = new Set(), downloads = new Map(), failures = new Map();
  const audit = (action, subject) => db.prepare('INSERT INTO audit(time,action,subject) VALUES(?,?,?)').run(now(), action, subject);
  const getUpload = id => { if (!idPattern.test(id)) fail(404, 'Upload not found.'); const row = db.prepare('SELECT * FROM uploads WHERE id=?').get(id); if (!row || now() - row.created > 86400000) fail(404, 'Upload expired or not found.'); return row; };
  const runLocked = async (id, action) => { if (locks.has(id)) fail(409, 'Upload is busy. Retry shortly.'); if (locks.size >= 2) fail(429, 'Two uploads are already active.'); locks.add(id); try { return await action(); } finally { locks.delete(id); } };
  function authenticate(req, admin) {
    const address = req.socket.remoteAddress ?? 'unknown';
    const token = /^Bearer ([A-Za-z0-9_-]{43,128})$/.exec(req.headers.authorization ?? '')?.[1];
    const digest = sha(token ?? '');
    let tester;
    const allowed = admin ? !!token && timingSafeEqual(Buffer.from(digest, 'hex'), adminHash) : !!token && (tester = db.prepare('SELECT id,expires,revoked FROM testers WHERE token_hash=?').get(digest)) && !tester.revoked && tester.expires > now();
    if (!allowed) {
      let bucket = failures.get(address); if (!bucket || now() > bucket.until) bucket = { count: 0, until: now() + 60000 };
      bucket.count++; if (failures.size > 10000) failures.clear(); failures.set(address, bucket);
      if (bucket.count > 30) fail(429, 'Too many denied requests. Try again in one minute.');
      fail(401, 'Access denied. Check your invitation or contact the game owner.');
    }
    return tester;
  }
  async function route(req, res) {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    const url = new URL(req.url, origin); const path = url.pathname; const method = req.method;
    if (url.search) fail(400, 'Query parameters are not accepted.');
    if (method === 'GET' && path === '/health') return respond(res, 200, { status: 'ok' });
    if (path.startsWith('/admin/')) {
      authenticate(req, true);
      if (path === '/admin/testers' && method === 'POST') {
        const { name, days = 30 } = await json(req);
        if (typeof name !== 'string' || !name.trim() || name.length > 100 || !Number.isInteger(days) || days < 1 || days > 90) fail(400, 'Supply a tester label and 1–90 access days.');
        const id = randomUUID(), token = randomBytes(32).toString('base64url'), expires = now() + days * 86400000;
        db.prepare('INSERT INTO testers(id,name,token_hash,expires,created) VALUES(?,?,?,?,?)').run(id, name.trim(), sha(token), expires, now()); audit('tester-issued', id);
        return respond(res, 201, { schema: 1, gameId: GAME, testerId: id, name: name.trim(), expires, feed: `${origin.origin}/v1/games/${GAME}/release`, token });
      }
      if (path === '/admin/testers' && method === 'GET') return respond(res, 200, db.prepare('SELECT id,name,expires,revoked,created FROM testers ORDER BY created DESC').all());
      const testerMatch = /^\/admin\/testers\/([0-9a-f-]{36})$/.exec(path);
      if (testerMatch && method === 'DELETE') { const result = db.prepare('UPDATE testers SET revoked=1 WHERE id=?').run(testerMatch[1]); if (!result.changes) fail(404, 'Tester not found.'); audit('tester-revoked', testerMatch[1]); return respond(res, 200, { revoked: true }); }
      if (path === '/admin/releases' && method === 'GET') return respond(res, 200, { active: db.prepare('SELECT version FROM channel WHERE id=1').get()?.version ?? null, releases: db.prepare('SELECT version,created,published FROM releases ORDER BY created DESC').all() });
      if (path === '/admin/releases' && method === 'POST') {
        const manifest = validateRelease(await json(req));
        if (db.prepare('SELECT 1 FROM releases WHERE version=?').get(manifest.version) || db.prepare('SELECT 1 FROM uploads WHERE version=?').get(manifest.version)) fail(409, 'This version already exists. Resume its upload or choose a new version.');
        if (db.prepare('SELECT count(*) AS count FROM uploads').get().count >= 20) fail(409, 'Remove abandoned uploads before creating more.');
        const disk = await import('node:fs/promises').then(fs => fs.statfs(root));
        if (disk.bavail * disk.bsize < manifest.size * 2 + 64 * 1024 * 1024) fail(507, 'Not enough server storage.');
        const id = randomUUID(); const file = await open(join(uploads, id), 'wx', 0o600); await file.close();
        db.prepare('INSERT INTO uploads(id,version,manifest,created) VALUES(?,?,?,?)').run(id, manifest.version, JSON.stringify(manifest), now()); audit('upload-created', id);
        return respond(res, 201, { id, offset: 0, chunkSize: CHUNK_SIZE });
      }
      if (path === '/admin/uploads' && method === 'GET') return respond(res, 200, db.prepare('SELECT id,version,offset,created FROM uploads ORDER BY created DESC').all());
      const uploadMatch = /^\/admin\/uploads\/([0-9a-f-]{36})(\/complete)?$/.exec(path);
      if (uploadMatch) {
        const id = uploadMatch[1];
        if (method === 'DELETE' && !uploadMatch[2]) return runLocked(id, async () => { if (!db.prepare('SELECT id FROM uploads WHERE id=?').get(id)) fail(404, 'Upload not found.'); await unlink(join(uploads,id)).catch(e => { if (e.code !== 'ENOENT') throw e; }); db.prepare('DELETE FROM uploads WHERE id=?').run(id); audit('upload-removed', id); respond(res, 200, { removed: true }); });
        if (method === 'GET' && !uploadMatch[2]) { const upload = getUpload(id); return respond(res, 200, { id, offset: upload.offset, size: JSON.parse(upload.manifest).size, sha256: JSON.parse(upload.manifest).sha256, chunkSize: CHUNK_SIZE }); }
        if (method === 'PUT' && !uploadMatch[2]) return runLocked(id, async () => {
          const upload = getUpload(id), manifest = JSON.parse(upload.manifest);
          const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(req.headers['content-range'] ?? '');
          if (!range || +range[1] !== upload.offset || +range[3] !== manifest.size || +range[2] < +range[1] || +range[2] >= manifest.size) fail(409, 'Upload offset or total does not match. Query the upload and retry.');
          const bytes = await body(req, CHUNK_SIZE);
          if (bytes.length !== +range[2] - +range[1] + 1 || sha(bytes) !== req.headers['x-chunk-sha256']) fail(400, 'Chunk size or checksum mismatch.');
          const file = await open(join(uploads, id), 'r+');
          try { await file.truncate(upload.offset); let written = 0; while (written < bytes.length) { const result = await file.write(bytes, written, bytes.length - written, upload.offset + written); if (!result.bytesWritten) throw new Error("Disk write made no progress"); written += result.bytesWritten; } await file.sync(); } finally { await file.close(); }
          db.prepare('UPDATE uploads SET offset=? WHERE id=?').run(upload.offset + bytes.length, id);
          return respond(res, 200, { id, offset: upload.offset + bytes.length });
        });
        if (method === 'POST' && uploadMatch[2]) return runLocked(id, async () => {
          const upload = getUpload(id), manifest = JSON.parse(upload.manifest), file = join(uploads, id);
          if (upload.offset !== manifest.size || (await stat(file)).size !== manifest.size) fail(409, 'Upload is incomplete.');
          if (await hashFile(file) !== manifest.sha256) fail(400, 'Archive checksum mismatch. Discard this upload and retry.');
          const header = await open(file, 'r'); const signature = Buffer.alloc(4); try { await header.read(signature, 0, 4, 0); } finally { await header.close(); }
          if (signature.readUInt32LE(0) !== 0x04034b50) fail(400, 'Release must be a ZIP archive.');
          const target = join(packages, `${manifest.version}.zip`);
          try { await copyFile(file, target, constants.COPYFILE_EXCL); } catch(e) { if (e.code === 'EEXIST') fail(409, 'A package already exists for this version; owner recovery is required.'); throw e; }
          db.exec('BEGIN IMMEDIATE');
          try { db.prepare('INSERT INTO releases(version,manifest,created) VALUES(?,?,?)').run(manifest.version, upload.manifest, now()); db.prepare('DELETE FROM uploads WHERE id=?').run(id); audit('release-verified', manifest.version); db.exec('COMMIT'); } catch(e) { db.exec('ROLLBACK'); await unlink(target); throw e; }
          await unlink(file); return respond(res, 201, { version: manifest.version, verified: true, active: false });
        });
      }
      if (path === '/admin/channel' && method === 'PUT') {
        const { version } = await json(req); if (typeof version !== 'string' || !db.prepare('SELECT 1 FROM releases WHERE version=?').get(version)) fail(404, 'Verified release not found.');
        db.exec('BEGIN IMMEDIATE');
        try {
          db.prepare('UPDATE releases SET published=1 WHERE version=?').run(version);
          db.prepare('INSERT INTO channel(id,version) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version').run(version); audit('channel-activated', version);
          db.exec('COMMIT');
        } catch(error) { db.exec('ROLLBACK'); throw error; }
        return respond(res, 200, { active: version });
      }
      if (path === '/admin/audit' && method === 'GET') return respond(res, 200, db.prepare('SELECT time,action,subject FROM audit ORDER BY id DESC LIMIT 100').all());
      fail(404, 'Owner operation not found.');
    }
    const tester = authenticate(req, false);
    if (method === 'GET' && path === '/v1/access') return respond(res, 200, { gameId: GAME, expires: tester.expires });
    if (method === 'GET' && path === `/v1/games/${GAME}/release`) {
      const row = db.prepare('SELECT manifest FROM releases JOIN channel ON releases.version=channel.version WHERE channel.id=1').get(); if (!row) fail(404, 'No release is available yet.');
      const manifest = JSON.parse(row.manifest); return respond(res, 200, { ...manifest, archive: `${origin.origin}/v1/games/${GAME}/releases/${manifest.version}/archive` });
    }
    const archiveMatch = /^\/v1\/games\/warplex-ae\/releases\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})\/archive$/.exec(path);
    if ((method === 'GET' || method === 'HEAD') && archiveMatch) {
      const row = db.prepare('SELECT manifest FROM releases WHERE version=? AND published=1').get(archiveMatch[1]); if (!row) fail(404, 'Release not found.');
      const manifest = JSON.parse(row.manifest), size = manifest.size;
      let start = 0, end = size - 1, status = 200;
      if (req.headers.range) { const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range); if (!range || +range[1] >= size || (range[2] && (+range[2] < +range[1] || +range[2] >= size))) { res.setHeader('Content-Range', `bytes */${size}`); fail(416, 'Invalid byte range.'); } start = +range[1]; end = range[2] ? +range[2] : end; status = 206; res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`); }
      if ((downloads.get(tester.id) ?? 0) >= 2) fail(429, 'Two downloads are already active for this tester.');
      res.setHeader('Content-Type', 'application/zip'); res.setHeader('Content-Length', end - start + 1); res.setHeader('Accept-Ranges', 'bytes'); res.setHeader('ETag', `"${manifest.sha256}"`);
      if (method === 'HEAD') { res.writeHead(status); return res.end(); }
      downloads.set(tester.id, (downloads.get(tester.id) ?? 0) + 1);
      try { res.writeHead(status); await pipeline(createReadStream(join(packages, `${manifest.version}.zip`), { start, end }), res); } finally { const count = downloads.get(tester.id) - 1; if(count) downloads.set(tester.id,count); else downloads.delete(tester.id); }
      return;
    }
    fail(404, 'Not found.');
  }
  return {
    db,
    close: () => db.close(),
    handle: (req, res) => { route(req, res).catch(error => { if (res.headersSent || res.destroyed) { res.destroy(); return; } respond(res, error.status ?? 500, { error: error.status ? error.message : 'The service could not complete this request.' }); }); }
  };
}
