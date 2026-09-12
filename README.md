# Journey Launcher

A native Windows game launcher for **Warplex: After Earth (Warplex AE)**, with a separate private release service and owner publishing tools. The approved Warplex logo is included unchanged. Journey is provisional launcher branding.

## Windows launcher

Open `Start-Launcher.cmd` after building, or run `out/JourneyLauncher.exe`. Windows x64 with .NET Framework 4.8 is required; no Node runtime is required for testers.

```powershell
powershell -ExecutionPolicy Bypass -File scripts/build.ps1 -Test
```

The build uses the Windows C# compiler and WPF. Keep `JourneyLauncher.exe.config` beside the executable; artwork is embedded. This is an unsigned portable app. Windows may warn about its publisher; code signing and launcher self-update are not implemented.

The game library offers Install, Update, Play, progress and cancellation, owner-written patch notes, installation-folder settings and existing-executable linking. The configured feed is checked on startup and manually. Versions are release identifiers: an owner can intentionally select an older version for rollback.

For private testing, choose **Settings → Import tester invitation**, review the HTTPS feed, and save. The invitation grants access to the configured game until expired or revoked. Keys are encrypted with Windows DPAPI in `%LOCALAPPDATA%/JourneyLauncher/settings.json` and sent only to the configured HTTPS origin. Import a new invitation when changing servers. Already downloaded games remain playable offline; tester access controls distribution rather than DRM.

For a local preview, select a release JSON file as the feed, or use **Link existing game** to select an executable. Linked games are never overwritten. An optional `out/bootstrap.json` can provide `{ "Feed": "absolute local manifest path or HTTPS URL" }` for first use. This machine-specific file is excluded from the repository.

## Private distribution and owner workflow

The [private service](service/README.md) is implemented and verified over HTTPS. It supports individual expiring tester keys, revocation, protected manifests and ZIP downloads, resumable chunk uploads, whole-package checksum verification, staged releases, activation/rollback and owner audit records. No hosted account or internet deployment is bundled or claimed.

Open `Owner-Desk.cmd` for the Windows owner menu, or use `service/owner.mjs`. The owner supplies a deployed service address and a private owner-key file. Node.js 24 is required for owner tools and the server. There are no npm dependencies. A [Docker/Caddy deployment](deploy/compose.yaml) is provided for an owner-approved separate server/hostname; it does not change any existing website or domain.

## Build and package Warplex AE

The game project and build outputs are **not** part of this public repository. `scripts/export-game.ps1` copies an explicitly supplied Godot project to a new private build workspace, checks matching template versions, exports Windows x64, includes official Godot notices, and packages the output. It preserves the original project. Supply official matching export templates and a Godot executable:

```powershell
pwsh -File scripts/export-game.ps1 -GameProject C:\PrivateGame -GodotExe C:\Godot\Godot_console.exe -TemplateDirectory C:\Godot\templates -Version 0.2.0-preview
```

For an existing exported game folder:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/package-game.ps1 -GameFolder C:\PrivateBuilds\WarplexAE -Version 0.2.0-preview
```

Output goes to ignored `private/releases`. Review and playtest a release, upload it through Owner Desk, then activate it for testers. The private service authenticates both manifest and archive requests. Do not put game ZIPs, sources, owner keys, invitation files or private data in GitHub Releases or this public repository.

Manifest format:

```json
{
  "gameId": "warplex-ae",
  "version": "0.2.0-preview",
  "archive": "warplex-ae-0.2.0-preview.zip",
  "sha256": "the archive's 64-character SHA-256 digest",
  "size": 123456,
  "unpackedBytes": 234567,
  "executable": "WarplexAE.exe",
  "notes": "Owner-written patch notes."
}
```

## Installation safeguards

The launcher bounds streamed download size, verifies byte count and SHA-256, and rejects unsafe ZIP paths, duplicate paths, links, alternate streams and excessive expansion. Every install uses a unique staging directory, followed by a rename and atomic preferences replacement. Failed or cancelled updates preserve the selected release. Old releases remain available on disk. Install paths containing junctions or symbolic links are rejected.

Limits are 1 MiB for manifest bodies, 20 GiB per compressed package, 60 GiB expanded and 100,000 entries. Transient HTTP request failures retry up to three attempts from the start; owner uploads resume in chunks, but tester-download resumption and delta patches are not yet implemented. Hard termination may leave unselected staging/download folders; review settings before removing them with the launcher closed. There is no automatic cleanup, uninstall or repair UI. Game save compatibility remains the game's responsibility.

Only configure feeds and invitations from the game owner. TLS authenticates the server, and checksums detect corrupted downloads; independently signed release manifests and Windows code signing remain planned. Private distribution does not prevent a tester from copying a downloaded game.

## Verification

- `scripts/build.ps1 -Test`: Windows installer and invitation/security checks; report in `out/test-results.txt`.
- `scripts/test-service.ps1` (PowerShell 7): real HTTPS service integration tests with an isolated certificate trusted only by the test client; no Windows trust-store change.
- `out/JourneyLauncher.exe --render output.png`: render the actual WPF window for layout review.
- `out/JourneyLauncher.exe --smoke-play`: invoke Play, wait for a game window, and request closure; report beside the executable.

A local-only provenance record may exist in ignored `LOCAL_SETUP.md`. Build output, service data, private releases and credentials are excluded from Git and the deployment image context.

References: [WPF](https://learn.microsoft.com/en-us/dotnet/desktop/wpf/overview/), [Godot exports](https://docs.godotengine.org/en/stable/tutorials/editor/command_line_tutorial.html), [Godot license requirements](https://docs.godotengine.org/en/stable/about/complying_with_licenses.html).
