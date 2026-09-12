# Cloudflare launcher setup

This is the default deployment for the private game service. It uses the existing **launcher** Worker, private **jdc-game-builds** R2 bucket, and **jdc-launcher** D1 database (`65e9238b-59a3-4996-ad39-c6f2775ad126`). The original website Worker and its domains are not involved.

## GitHub Create and deploy fields

| Field | Value |
| --- | --- |
| Repository | `journeydefined/launcher` |
| Production branch | `main` |
| Worker/project name | `launcher` |
| Root directory | Repository root (leave blank, or `.` if required) |
| Build command | Leave blank |
| Deploy command | `npx wrangler deploy` |

Dependencies and the Wrangler version are pinned in `package.json` and `package-lock.json`; Workers Builds installs them automatically. No framework build is needed. Root `wrangler.toml` bundles `cloudflare/worker.mjs`, binds the exact existing D1/R2 resources, enables `workers.dev`, and disables preview URLs. There are no custom-domain routes, public assets, or public R2 endpoints.

If an earlier Deploy was clicked before these files existed, let the push of this implementation trigger a new build of **latest main**. A retry of the old source commit will still lack the Worker. If no new build starts, trigger a new deployment of latest main or finish the repository connection. Do not create another Worker or replace the website project.

## First deployment is intentionally locked

The initial Worker deploy does **not** run migrations, create testers or publish a game. `/health` returns HTTP 503 with `status: setup-required` until both the runtime owner secret and schema are ready. All private/owner routes are denied during that state. A deployment can therefore succeed safely before setup is finished.

1. In **Workers & Pages → launcher → Settings → Variables and Secrets**, add a **Secret** named **`OWNER_TOKEN`**. Its value is the *contents* of the owner's private key file, not the filename. Save/deploy that runtime change. Do not put this secret in Build variables, Wrangler `[vars]`, a URL, GitHub, or chat. A private key has been prepared on the owner's computer at `E:\launcher\private\owner.key`; it has not been committed. For a different setup, generate one with `node service/owner.mjs init --key-file private/owner.key`.
2. Copy the actual HTTPS `workers.dev` address shown on the Worker overview. Use the base address, with no `/admin` or `/v1` suffix.
3. Open **Owner-Desk.cmd**, enter that HTTPS address and the private owner-key file path, and choose **8 — Initialize Cloudflare database**. This calls the authenticated `/admin/bootstrap` endpoint to run the checked-in schema. It is explicit, idempotent and non-destructive. It works through the Worker binding and does not need a Cloudflare API token on the owner's computer.
4. Visit `https://ACTUAL-WORKER-ADDRESS/health`. Expect HTTP 200 and `status: ok`, `ownerSecret: true`, `schemaReady: true`. Anonymous game-manifest and archive requests should still return 401. A valid tester sees 404 for the feed until a release is activated.

CLI alternative for step 3:

```powershell
node service/owner.mjs bootstrap --url https://ACTUAL-WORKER-ADDRESS --key-file private/owner.key
```

Migration alternative for an authenticated Wrangler administrator: `npm run db:migrate`, which runs `wrangler d1 migrations apply jdc-launcher --remote`. The same non-destructive SQL is in `migrations/0001_cloudflare.sql`. Choose one setup route; repeating either does not clear existing data. Bootstrap is schema-v1 setup, not a generic future-migration endpoint: future schema upgrades require checked-in migrations and deliberate application.

## Publish the first private game

The existing owner menu and invitation format remain compatible. Use the live Worker address and owner-key file:

1. Owner Desk **4** uploads an existing local package manifest. The current Windows release is in `private/releases/warplex-ae-0.1.1-preview.json`. The owner tool resumes upload parts and then displays verification progress. It stages the release only after whole-archive SHA-256 verification succeeds.
2. Owner Desk **5** activates the verified version. Previous activated versions remain available for in-progress updates and rollback. Staged versions are inaccessible to testers, even if they guess the archive URL.
3. Owner Desk **1** issues an individual invitation valid for 1–90 days. Save it in a private folder and transfer it privately to the intended tester. The launcher imports it via Settings. Never use the owner key as a tester token.
4. Owner Desk **3** revokes a tester. Subsequent manifest/archive requests are denied. Already downloaded games remain playable offline, and an already authorized stream may finish.

Public R2 access must remain disabled. The Worker streams all game bytes through authenticated routes. It does not create signed public download URLs or upload private game files to GitHub.

## Why verification is resumable

A Worker cannot safely buffer or hash an arbitrary game archive in one invocation. This implementation:

- Accepts **5 MiB** multipart parts (the final part may be smaller), checks exact lengths and streams each part through native SHA-256 before recording its R2 ETag in D1.
- Completes the multipart object at an opaque private R2 key. Completion is recoverable after an interrupted response.
- Re-reads the completed object in **256 KiB** ranges and checkpoints the full SHA-256 state in D1 between requests. Each step checks the object's ETag. The existing owner publisher repeats `/complete` until verification finishes; quitting/restarting the publisher resumes from D1 state.
- Compares the final digest with the local manifest's full-file SHA-256. Per-part checksums or multipart ETags are never substituted for the full checksum.
- Inserts a verified release only after the digest matches, then separately activates it. Downloads also pin the verified R2 ETag; replacement of an object outside the service is rejected.

The checkpoint adapter uses exact pinned `@noble/hashes` 2.4.0 internals and has native-reference tests across partial/full block boundaries. Upgrade that dependency only with the adapter tests. Hash state comes only from server-generated D1 data, never request JSON.

The Cloudflare backend currently caps compressed packages at **1 GiB** to bound part counts and verification requests. The desktop installer and optional Node backend have higher limits; that does not override the Cloudflare publishing cap. The tested Warplex archive is 65,661,490 bytes and requires 250 intermediate verification checkpoints. Small bounded steps control memory and CPU work, but emulator tests do not guarantee a particular live plan's CPU allowance. Inspect live Worker metrics after the first upload. No paid-plan upgrade or budget change is assumed. Request, D1 and R2 usage still count toward the account's limits.

## Recovery and operating notes

- D1 leases fence upload mutations across Worker instances. A terminated operation may hold a lease for up to two minutes; retry after it expires. Responses report progress so accepted parts are not uploaded again after a lost response.
- Active upload sessions expire after 24 hours. Use `owner.mjs uploads` and `discard-upload --id ID` for abandoned/failed sessions. Cleanup cannot delete a verified release. R2's own incomplete-multipart lifecycle remains an additional safety net. Cross-service failures can leave unselected objects; review ownership and D1 records before manual cleanup, never bulk-delete the bucket.
- Owner upload completion is idempotent. If the final response was lost, query `releases` before starting another upload with the same version. A verified version is immutable.
- Token hashes, expiry and revocation are in D1. Raw tester tokens are returned once in invitations; raw owner tokens are runtime secrets. There is no account-password system or email delivery.
- Denied-access throttling is best-effort per Worker isolate, not a global quota. D1 leases provide cross-instance upload coordination; the Node backend's in-process download limits are not advertised as global Worker limits. Use account/edge controls and usage monitoring as needed.
- Back up D1 and preserve private R2 game objects before operational changes. The migration contains no DROP or destructive reset. Removing the owner runtime secret makes the service fail closed, including tester downloads.

## Validation and status

`npm test` runs the Worker in Cloudflare's workerd runtime with local D1/R2. It tests missing setup, authenticated/idempotent bootstrap, hashed keys, expiry/revocation, bad parts, leases, resumed uploads and full verification, staging/activation/rollback, full/range streaming, immutable releases, R2 overwrite rejection and owner-protocol retry bounds.

`npm run check:worker` performs a dry-run build and lists bindings without deploying. For a private real-package probe, run `node cloudflare/tests/real-package.mjs PATH-TO-MANIFEST`; this uses local emulator storage and never uploads the game to the internet.

Live deployment and live upload still require the dashboard setup above. Local emulator success is not represented as an already-live service.

References: [Workers Builds fields](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/), [runtime secrets](https://developers.cloudflare.com/workers/configuration/secrets/), [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/), [R2 multipart](https://developers.cloudflare.com/r2/api/workers/workers-multipart-usage/), [R2 Worker API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/), [Worker limits](https://developers.cloudflare.com/workers/platform/limits/).
