# Private release service

The service and owner tools are implemented and tested. **No internet deployment has been created.** A live hostname and server remain to be supplied. The existing Journey Defined website and Cloudflare Worker are separate and must remain unchanged.

## What the owner can do

Open `Owner-Desk.cmd` on Windows for a menu, or use the CLI below. It asks for the deployed service's HTTPS address and your private owner-key file. Node.js 24 LTS is required for owner tools and the server; the Windows game launcher itself does not require Node.

1. Package the game with `scripts/package-game.ps1`.
2. Upload it. The tool verifies the local ZIP, resumes interrupted uploads in 8 MiB chunks, and the service verifies the complete SHA-256 digest. A verified release is initially staged.
3. Activate the chosen version. Testers see that version on the next launcher startup or update check. Activating an older verified version rolls the channel back; existing packages are immutable.
4. Issue an invitation for each tester, valid for 1–90 days. Transfer the generated file privately. Testers select **Settings → Import tester invitation → Save settings** in the launcher.
5. List and revoke testers at any time. Revocation and expiry block subsequent manifest and archive requests. They do not erase downloaded builds or prevent offline play. An already authorized transfer may finish.

Invitations are bearer credentials, not DRM or identity-verified accounts. Anyone holding a copied invitation has its access until revoked or expired. No email is sent automatically, and no account password is collected. Reissue an invitation when a tester needs access extended; revoke the old one. Launcher storage uses Windows DPAPI, while the service stores only SHA-256 hashes of the high-entropy tester keys.

## Deployable setup

The backend uses Node.js 24's built-in SQLite, filesystem storage, HTTP/TLS, and cryptography modules; there are no npm dependencies. A small always-on server with persistent local disk and HTTPS is sufficient. It is **not** a Cloudflare Worker and should not replace the website Worker. Cloudflare DNS/proxy can front a separate service if the owner later chooses, but is not required. Upload chunks stay below the usual Cloudflare proxy request-body limit.

A ready Docker Compose configuration is under `deploy/`. It creates only the release service and a dedicated Caddy HTTPS proxy. It does not include domain changes, account creation, billing activation, or game data. Configure a **new, owner-approved release hostname**, existing server, and DNS record before running it. Do not run the proxy on a host already using ports 80/443 without integrating with that host's existing proxy instead.

Generate the owner key locally (the tool writes it to a file and never prints it):

```powershell
node service/owner.mjs init --key-file private/owner.key
```

For Docker on the selected server, supply `RELEASE_HOST` (hostname only) and `OWNER_KEY_PATH` (private key-file path). Make the key readable by the container service user through a protected Docker secret mount; verify host file permissions. Start with:

```sh
docker compose -f deploy/compose.yaml up -d --build
```

The database, private packages and uploads live in `release_data`. Caddy persists certificate state separately. The service port is exposed only inside Docker; only the HTTPS proxy is published. Pin reviewed image digests before a production rollout. Docker/Caddy execution is supplied as deployable configuration and was not run on this Windows machine, where Docker is not installed. Caddy certificate issuance requires a working hostname and reachable ports; no certificate issuance was attempted here.

Without Docker, use Node 24 with `DATA_DIR`, `OWNER_KEY_FILE`, and `PUBLIC_ORIGIN=https://your-approved-release-host`. Supply `TLS_CERT_FILE` and `TLS_KEY_FILE` for direct TLS, or put the default `127.0.0.1:8788` listener behind an existing HTTPS proxy. Never publish a plaintext listener. `BEHIND_TLS_PROXY=1` allows a non-loopback plaintext listener only for an isolated proxy network. Run one service process per data directory; SQLite and files are designed for a single persistent server, not serverless/ephemeral disks or a multi-node cluster.

## Owner CLI

Every owner request uses a separate owner key. Testers cannot call owner APIs. Keys are read from files, not placed in command-line arguments or URLs.

```powershell
node service/owner.mjs invite --url https://your-release-host --key-file private/owner.key --name "Tester label" --days 30 --out private/tester.invite.json
node service/owner.mjs testers --url https://your-release-host --key-file private/owner.key
node service/owner.mjs revoke --url https://your-release-host --key-file private/owner.key --id TESTER-ID
node service/owner.mjs publish --url https://your-release-host --key-file private/owner.key --manifest private/releases/warplex-ae-VERSION.json
node service/owner.mjs releases --url https://your-release-host --key-file private/owner.key
node service/owner.mjs activate --url https://your-release-host --key-file private/owner.key --version VERSION
```

`publish --activate` combines successful verification with activation when explicitly desired. Retrying `publish` resumes a matching unexpired upload after verifying the local archive again. If the last completion response was lost, inspect `releases` before retrying: a completed release will already exist and cannot be overwritten. Use `uploads` and `discard-upload --id UPLOAD-ID` to remove abandoned upload sessions. Sessions expire after 24 hours and must be discarded before reusing their version. Use `audit` to view the last 100 owner operations.

## Security and operational scope

- Both manifests and archive bytes require valid tester access on every request. Private storage has no static-file/public bucket endpoint. There are no credentials or tokens in query strings, redirects, response caches or audit records.
- A 32-byte random owner key controls upload, activation and tester access; rotate it by generating a replacement and restarting the server with the new file. The old key then stops working. Keep it in a restricted private location; POSIX file mode 600 is applied by tooling, while Windows administrators must ensure the folder ACL grants only intended users. Do not commit owner keys or invitations.
- Upload chunks have byte-count and SHA-256 checks; the final archive gets full streaming SHA-256 verification before becoming a release. ZIP content is checked by the launcher before installation. The owner is trusted to publish the intended executable; there is no automatic malware scanning or digital publisher signature.
- Release activation is a single SQLite update. Failed uploads leave the active version unchanged. Completion copies to an exclusive immutable package path before adding its database record. A crash at that boundary can leave an orphan package requiring owner review; it cannot silently replace an existing release.
- SQLite uses WAL and FULL synchronous mode. Back up the complete data directory and owner key while the service is stopped, and test restoration before inviting external testers. Monitor disk space and delete only reviewed abandoned uploads; there is no automated retention policy. Packages require roughly twice their compressed size during upload completion.
- Anonymous denied requests are throttled per socket IP. Valid transfers are limited to two per tester; two upload mutations can run concurrently. Use normal host/proxy connection and traffic limits for an internet deployment. No billing limit is enforced by this application.
- The launcher trusts TLS and the owner-supplied invitation server. Windows code signing, independently signed release manifests, account login, refresh-token/device enrollment and launcher self-update remain future work. Unsigned executables may show a Windows publisher warning.

## Tested

Run `scripts/test-service.ps1` from PowerShell 7 on Windows. It generates an isolated one-day localhost certificate in ignored private test files and runs actual HTTPS requests with that certificate explicitly trusted by the test client only. It does not add a Windows trust root or disable certificate verification. The suite covers anonymous denial, owner/tester separation, hashed keys, expiry/revocation, invalid releases, corrupt/out-of-order chunks, resumable publishing, activation/rollback, protected full/range downloads, immutable versions and audit secrecy. The Windows install tests run separately through `scripts/build.ps1 -Test`.

References: [Node SQLite](https://nodejs.org/api/sqlite.html), [Caddy automatic HTTPS](https://caddyserver.com/docs/automatic-https), [Cloudflare request limits](https://developers.cloudflare.com/workers/platform/limits/).
