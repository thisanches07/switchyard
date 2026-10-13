# 0018. Hot-reload the config file by polling it, with an admin endpoint and SIGHUP as explicit triggers

- **Status:** Accepted
- **Date:** 2026-10-13
- **Related specs:** 008

## Context
Spec 008 makes aliases, candidates, retry and circuit-breaker settings reloadable without a restart: restarting drops in-flight streams and resets breaker and latency state. The gateway must notice a changed `config/switchyard.yaml`, validate it with the existing Zod schema, and swap it in for new requests only; an invalid file must never replace a valid one.

The environments differ:
- **Primary dev machine is Windows 10** running the gateway natively (`pnpm dev`) or in Docker Desktop on WSL2.
- In `docker-compose.yml` the config directory is a **bind mount** (`./config:/app/config:ro`). When the file lives on the Windows filesystem, edits made on the Windows side do not produce inotify events inside the Linux container, so `fs.watch` in the container never fires.
- Editors (VS Code, vim, JetBrains) usually save by writing a temp file and **renaming** it over the original. On Linux, an `fs.watch` on the file then watches a dead inode after the first save; on Windows, `fs.watch` often fires several events per save.
- Kubernetes ConfigMaps (a likely later deployment, spec 013) update by swapping a `..data` symlink, which also defeats file-level inotify watches.
- CI runs on Ubuntu; tests need a deterministic way to trigger a reload without sleeping on file events.

## Options considered
1. **`fs.watch` (inotify / ReadDirectoryChangesW) on the file or its directory**: instant and cheap, but misses changes across Docker Desktop bind mounts, needs directory watching plus filtering to survive atomic renames and symlink swaps, and behaves differently per platform.
2. **chokidar**: smooths over `fs.watch` quirks, but is a new dependency, and on bind mounts it still needs `usePolling`, which is what option 3 does with no dependency.
3. **Stat polling of the path (`fs.watchFile`, e.g. every 2 s) plus a content hash**: works the same on Windows, Linux, bind mounts, atomic renames and symlink swaps, because it re-stats the *path*; costs one `stat` per interval for one file; adds up to one interval of delay.
4. **`SIGHUP` only**: the Unix convention, explicit and race-free, but Windows has no `SIGHUP` for Node processes, and it needs shell or `docker kill -s HUP` access.
5. **Admin endpoint only (`POST /admin/config/reload`)**: explicit, cross-platform, scriptable and easy to test, but someone has to remember to call it, and it only reloads the instance that receives it.

## Decision
We will combine three triggers that all run the same reload routine:
- **Stat polling** of the config path (option 3) every 2 s while `routing.hotReload` is `true` (default). A changed `mtime` or size triggers a read; the reload proceeds only if the SHA-256 of the content differs from the active one, which absorbs duplicate events and touch-only saves. A short debounce (about 500 ms after the last change) avoids reading a half-written file.
- **`POST /admin/config/reload`** behind the admin token (option 5), for deterministic tests, CI and orchestrators; it reports `reloaded` or `unchanged`, or `400 invalid_config` with the issues.
- **`SIGHUP`** on non-Windows platforms (option 4), as an extra for operators used to it.

The reload routine parses YAML, validates with the Zod schema, and on success atomically replaces the config snapshot read by new requests; in-flight requests keep the snapshot they started with. On failure it keeps the old snapshot, logs the issues without secret values and increments `switchyard_config_reloads_total{result="failure"}`. Settings bound at startup (`server.bodyLimitBytes`, `server.trustProxy`) are not reloaded; a change to them is logged as needing a restart.

## Consequences
- ✅ One behaviour on the Windows dev machine, in Compose with bind mounts, on Linux CI and in Kubernetes, with no new dependency.
- ✅ An invalid edit never takes the gateway down, and tests can reload synchronously through the endpoint.
- ⚠️ Up to about 2.5 s between saving the file and the change taking effect; the endpoint is the way to apply it at once.
- ⚠️ Each instance reloads on its own: for a few seconds, instances may serve with different configs, and the endpoint reloads only the instance that receives it.
- ⚠️ Environment variables (provider keys, URLs via `*Env`) are read at reload time from the process environment, which does not change; rotating a secret still needs a restart.
- 🔁 Revisit if config moves to a database or a remote source (then push or watch that source instead), or if 2 s polling shows up in the idle CPU budget.
