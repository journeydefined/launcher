import { createServer as httpServer } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { readFile } from 'node:fs/promises';
import { createService } from './service.mjs';
const host = process.env.LISTEN_HOST ?? '127.0.0.1';
const tls = process.env.TLS_CERT_FILE && process.env.TLS_KEY_FILE;
if (!tls && host !== '127.0.0.1' && process.env.BEHIND_TLS_PROXY !== '1') throw new Error('A non-loopback listener requires TLS or explicit BEHIND_TLS_PROXY=1 on an isolated network.');
const adminToken = (await readFile(process.env.OWNER_KEY_FILE ?? 'private/service/owner.key', 'utf8')).trim();
const service = await createService({ dataDir: process.env.DATA_DIR ?? 'private/service/data', publicOrigin: process.env.PUBLIC_ORIGIN, adminToken });
const server = tls ? httpsServer({ cert: await readFile(process.env.TLS_CERT_FILE), key: await readFile(process.env.TLS_KEY_FILE), minVersion: 'TLSv1.2' }, service.handle) : httpServer(service.handle);
server.maxConnections = 256;
server.requestTimeout = 120000; server.headersTimeout = 15000; server.maxRequestsPerSocket = 1000;
server.listen(Number(process.env.PORT ?? 8788), host, () => console.log(`Private release service listening on ${host}:${server.address().port}.`));
for(const signal of ['SIGTERM','SIGINT'])process.on(signal, () => { server.close(() => { service.close(); process.exit(0); }); setTimeout(() => process.exit(1), 10000).unref(); });

