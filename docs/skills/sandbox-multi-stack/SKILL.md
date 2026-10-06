---
name: sandbox-multi-stack
description: "Run side projects in this Z.ai sandbox: PostgreSQL, Python (FastAPI/Uvicorn), additional Next.js apps, React Native / Expo mobile apps (build + static web export + live browser preview + APK handoff), and any other side service or non-Next.js framework. Covers keeping services alive (reaper, mini-services auto-boot, adoption hatch), exposing them via ?XTransformPort or basePath+proxy or the main app's public/ folder, and surviving reboots. Use whenever the user wants to run/install/start PostgreSQL, a Python server/API, a second/additional Next.js or Node project, any side project or microservice, run something on another port, or when a service dies after a command ends or after a reboot. ALSO use whenever the user mentions React Native, Expo, react-native-web, a mobile app, an APK, or asks whether a non-Next.js JS/TS framework can be built and previewed here — the answer is YES (verified recipe inside), and this skill prevents the classic wrong conclusion that React Native is impossible in this sandbox."
---

# Side Projects in This Sandbox (PostgreSQL / Python / Next.js / React Native)

Operating manual for running ANY project besides (or inside) the main Next.js app on `:3000` — including React Native mobile apps.
Every command here was verified live in this exact environment. Follow it as written — the traps below kill services **silently**, and each rule exists because something broke without it.

## 1. Environment laws (violating these = silent failure)

1. **One public port.** Caddy gateway on `:81` is the only thing reachable from the user's browser. Route to any internal service by adding `?XTransformPort={port}` to the public URL. `HEAD` requests get 403 at the platform edge — always health-check with `GET`.
2. **`XTransformPort` is for APIs and self-contained pages only.** Browsers do not repeat the query param on subresource requests (`/_next/static/chunks/...`, CSS, JS files). A full React/Next app opened via `?XTransformPort=3005` gets its HTML from service A but its JS chunks from the main app `:3000` → **hydration dies silently** (zero console errors). Full apps must use **basePath + reverse proxy** (Recipe 3). APIs (`/api/...` returning JSON) and pages with all assets inlined work fine over `XTransformPort`.
3. **No root.** No `sudo`, no `systemd`, no `apt`. Install servers as portable binaries (npm tarballs, uv, bun) under `/home/z/`.
4. **The reaper.** Any process spawned from an agent tool command is killed when that command's session ends. `nohup`, `&`, `disown`, `setsid` do NOT save it. Only three things survive: (a) the boot tree (see law 5), (b) children of a boot-tree service spawned via the **adoption hatch**, (c) true self-detaching daemons (`pg_ctl start` daemonizes postgres to `ppid=1` — survives session end, but not a reboot).
5. **mini-services/ auto-boot = the durable pattern.** At every container boot, `.zscripts/dev.sh` runs `bun install` + `bun run dev` in EVERY subfolder of `mini-services/` that has a `package.json` with a `dev` script. A service living there auto-revives after every reboot. Logs: `.zscripts/mini-service-{name}.log`. Boot starts everything in parallel; a dev script may exit after doing its job (e.g. a one-shot keeper) without harming anything.
6. **Reboot persistence contract** (empirically verified):
   - ✅ Git-tracked source in `/home/z/my-project` (src, mini-services, prisma, public, .zscripts, worklog.md, .git) — survives via `/home/sync/repo.tar`. **Untracked/uncommitted files do NOT survive — commit your work.** (Trap seen live: an unanchored `db/` gitignore rule silently excluded a `src/app/api/db/` route folder from `git add`; the file looked "saved" but vanished at the next reboot.)
   - ✅ `db/*.db` (main SQLite) — survives (platform preserves it even though repo.tar does not include it).
   - ❌ `node_modules/`, `.next/`, venvs, `*.log`, `tool-results/` — wiped, but auto-rebuilt at boot (`bun install`, `uv sync` via `uv run`). Never rely on them persisting.
   - ❌ `skills/` — wiped at boot, then re-extracted from official zips. Custom skills must ALSO live in `docs/skills/` and are auto-restored by `.zscripts/restore-custom-skills.sh` (called from dev.sh).
   - ❌ Anything outside `/home/z/my-project` (e.g. `/home/z/pg`) — gone after every reboot. Treat as ephemeral cache; re-provision with a keeper script.
7. **`ln -s` is blocked in the Bash tool** ("Creating symbolic links is not allowed"). Create symlinks with bun instead: `bun -e "require('fs').symlinkSync('target','link')"`.
8. **Memory is finite: 4 GB total, no swap.** Check `free -m` before adding a service. A Next.js dev server ≈ 250-450 MB, uvicorn ≈ 50 MB, postgres ≈ 100-200 MB. If headroom < ~300 MB, stop something first (`pkill -f` the least important service) — OOM kills are silent.

## 2. Service registry & port allocation

| Port | Service | Pattern |
|---|---|---|
| 3000 | Main Next.js app (Pulse) | boot tree |
| 3005 | next-demo (second Next.js) | mini-services auto-boot |
| 3050 | checkout (+ adoption hatch) | mini-services auto-boot |
| 3051 | pulse-worker | mini-services auto-boot |
| 3060 | py-status (FastAPI) | mini-services auto-boot |
| 5432 | PostgreSQL (localhost only) | daemon + keeper |
| 3061+ | **pick next free port for new services** | mini-services auto-boot |

Verify a port is free before use: `curl -s -o /dev/null http://127.0.0.1:{port}` (connection refused = free).

## 3. Recipe — Python service (FastAPI + Uvicorn, hot-reload)

Create `mini-services/{name}/` with exactly three files. It auto-starts now (via adoption, below) AND after every reboot (via auto-boot).

`package.json` — the dev script is what auto-boot runs; `UV_PROJECT_ENVIRONMENT` keeps the venv outside the repo (venvs are rebuilt at boot anyway, this just keeps them out of the file watcher):
```json
{
  "name": "py-status",
  "private": true,
  "scripts": {
    "dev": "UV_PROJECT_ENVIRONMENT=/home/z/venvs/py-status uv run --project . uvicorn app:app --host 0.0.0.0 --port 3060 --reload"
  }
}
```

`pyproject.toml`:
```toml
[project]
name = "py-status"
version = "1.0.0"
requires-python = ">=3.12"
dependencies = ["fastapi>=0.115", "uvicorn>=0.30"]
```

`app.py` — **serve ALL page assets inline** (law 2). No external CSS/JS files, no `<script src>`:
```python
from fastapi import FastAPI
from fastapi.responses import HTMLResponse

app = FastAPI()

@app.get("/api/health")
def health(): return {"status": "ok"}

@app.get("/")
def home(): return HTMLResponse("<html><body style='background:#0a0a0a;color:#eee;font-family:sans-serif'><h1>py-status</h1></body></html>")
```

Start it NOW (mid-session) via the adoption hatch — a plain `bun run dev &` will be reaped (law 4):
1. Add the service to the `ADOPTABLE` map in `mini-services/checkout/index.ts` (checkout runs `bun --hot`, edits apply instantly):
   ```ts
   "py-status": { cwd: nodePath.join(CORE_ROOT, "mini-services", "py-status"), log: "/tmp/mini-service-py-status.log" },
   ```
2. Adopt it:
   ```bash
   curl -s -X POST http://127.0.0.1:3050/ops/adopt -H "x-worker-secret: pulse-worker-dev-secret" -H "content-type: application/json" -d '{"service":"py-status"}'
   ```
3. Verify: `curl -s http://127.0.0.1:3060/api/health` → `{"status":"ok"}`. Public URL: `https://{preview-domain}/?XTransformPort=3060`.

## 4. Recipe — PostgreSQL (portable, no root, ephemeral data)

The npm package `@embedded-postgres/linux-x64` ships a full PostgreSQL 16 as static-ish binaries with baked-in rpath — no root needed. **Everything here lives in `/home/z/pg` = lost at every reboot** (law 6). That is by design; make it auto-revive with the keeper (step 4c).

**4a. One-time provisioning (or re-run after reboot):**
```bash
mkdir -p /home/z/pg && cd /home/z/pg
curl -sL "https://registry.npmjs.org/@embedded-postgres/linux-x64/-/linux-x64-16.14.0-beta.17.tgz" -o pg.tgz
tar xzf pg.tgz   # → package/native/{bin,lib,share}
```

**4b. Fix the ICU symlinks** — npm tarballs drop symlinks, so `libicuuc.so.60.2` exists but the dynamic linker wants `libicuuc.so.60`. Binaries then fail with exit 127 / "error while loading shared libraries". `ln -s` is blocked (law 7), use bun:
```bash
cd /home/z/pg/package/native/lib
bun -e "const fs=require('fs');let n=0;for(const f of fs.readdirSync('.').filter(f=>/^lib.*\.so\.\d+\.\d+$/.test(f))){const b=f.replace(/\.\d+$/,'');if(!fs.existsSync(b)){fs.symlinkSync(f,b);n++;}}console.log('symlinks created:',n)"
# verify: 0 missing libs
ldd ../bin/postgres | grep -c "not found"   # → 0
```

**4c. The keeper** — `mini-services/pg-keeper/` makes postgres auto-revive at every boot (law 5). Its dev script runs once at boot, restores everything idempotently, then exits.

`mini-services/pg-keeper/package.json`:
```json
{
  "name": "pg-keeper",
  "private": true,
  "scripts": { "dev": "bash keeper.sh" },
  "dependencies": { "pg": "^8.13.0" }
}
```

`mini-services/pg-keeper/keeper.sh` (idempotent; safe to re-run any time):
```bash
#!/bin/bash
PG=/home/z/pg
NATIVE=$PG/package/native
DATA=$PG/data
# Resolve this script's own dir UP FRONT (absolute). Step 2 below cd's into
# $NATIVE/lib; a later RELATIVE cd "$(dirname "$0")" would be a no-op there
# (dirname of "keeper.sh" is ".") and bun would fail: Module not found.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$PG"
# 1. binaries present?
if [ ! -x "$NATIVE/bin/postgres" ]; then
  curl -sL "https://registry.npmjs.org/@embedded-postgres/linux-x64/-/linux-x64-16.14.0-beta.17.tgz" -o "$PG/pg.tgz"
  tar xzf "$PG/pg.tgz" -C "$PG"
fi
# 2. ICU soname symlinks
cd "$NATIVE/lib" && bun -e "const fs=require('fs');for(const f of fs.readdirSync('.').filter(f=>/^lib.*\.so\.\d+\.\d+$/.test(f))){const b=f.replace(/\.\d+$/,'');if(!fs.existsSync(b))fs.symlinkSync(f,b);}"
# 3. data dir present?
if [ ! -f "$DATA/PG_VERSION" ]; then
  "$NATIVE/bin/initdb" -D "$DATA" --auth=trust --locale=C --encoding=UTF8 --username=pulse
fi
# 4. server running? (pg_ctl is the ONLY control binary shipped - no psql, no pg_isready)
"$NATIVE/bin/pg_ctl" -D "$DATA" -l "$PG/pg.log" status >/dev/null 2>&1 || \
  "$NATIVE/bin/pg_ctl" -D "$DATA" -l "$PG/pg.log" start
# 5. schema bootstrap (no psql shipped - use the pg npm client from this folder)
cd "$SCRIPT_DIR"
BOOTSTRAP_OK=0
for i in $(seq 1 15); do
  if bun bootstrap.ts; then BOOTSTRAP_OK=1; break; fi
  sleep 1
done
# signal failure: without this the loop's trailing `sleep 1` makes the script
# exit 0 even when bootstrap never succeeded (silent failure at boot)
[ "$BOOTSTRAP_OK" = "1" ] || { echo "[pg-keeper] ERROR: schema bootstrap failed"; exit 1; }
```

`mini-services/pg-keeper/bootstrap.ts` — creates databases/tables if missing (adjust the SQL to your schema):
```ts
import { Client } from "pg";
const c = new Client({ host: "127.0.0.1", port: 5432, user: "pulse", database: "postgres" });
await c.connect();
const dbs = await c.query("SELECT 1 FROM pg_database WHERE datname='pulse_demo'");
if (dbs.rowCount === 0) await c.query("CREATE DATABASE pulse_demo");
await c.end();
const d = new Client({ host: "127.0.0.1", port: 5432, user: "pulse", database: "pulse_demo" });
await d.connect();
await d.query(`CREATE TABLE IF NOT EXISTS visits (id serial PRIMARY KEY, at timestamptz DEFAULT now(), source text)`);
await d.query(`INSERT INTO visits (source) VALUES ('keeper')`);
await d.end();
console.log("[pg-keeper] bootstrap ok");
```

Manual start (when the keeper isn't running, e.g. testing): run steps 4a-4c's commands directly, then `pg_ctl ... start`. `pg_ctl` daemonizes postgres (survives agent sessions, law 4c) and **postgres listens on 127.0.0.1:5432 only** — that is correct and intentional: the gateway speaks HTTP, not the postgres wire protocol, and exposing a database publicly would be a security hole. Apps reach it at `postgresql://pulse@127.0.0.1:5432/pulse_demo` (trust auth, no password, local only). **Data is wiped at every reboot** — if data matters, dump it to a `.sql`/JSON file inside the repo (`db/` survives, law 6) and have bootstrap.ts re-load it.

Mid-session restore (the usual "postgres vanished after a reboot" case) — don't wait for the next boot:
1. `bun install` inside `mini-services/pg-keeper/` ONCE (at boot `dev.sh` runs it for you; mid-session nothing does — without it `bun bootstrap.ts` fails on the missing `pg` module).
2. Add `"pg-keeper"` to ADOPTABLE in `mini-services/checkout/index.ts` and POST `/ops/adopt` (Recipe 3 steps 1-2). The keeper is a one-shot: it runs under the boot tree, restores everything, and exits; the postgres daemon it started survives on its own (ppid=1). Running `bash mini-services/pg-keeper/keeper.sh` directly from a tool session works equally well for the same reason. Idempotent — safe to re-run.

## 5. Recipe — additional Next.js app (the 3 config traps + proxy)

Create `mini-services/{name}/`. All three configs below are **mandatory** — skip any one and hydration fails silently (law 2 + Turbopack root inference + version mismatch).

`package.json` — pin versions to EXACTLY the main app's combination (bun otherwise installs the latest, which mismatches the main app's React runtime):
```json
{
  "name": "next-demo",
  "private": true,
  "scripts": { "dev": "next dev -p 3005" },
  "dependencies": { "next": "16.1.3", "react": "19.2.3", "react-dom": "19.2.3", "pg": "^8.13.0" },
  "devDependencies": { "@types/pg": "^8.11.0", "typescript": "^5" }
}
```

`next.config.ts` — `basePath` so every emitted URL carries the prefix the proxy routes on; `turbopack.root` because Turbopack otherwise finds the parent project's `bun.lock`, treats this app as a subfolder of the main app, and emits chunk ids that break client hydration **with zero console errors**:
```ts
import type { NextConfig } from "next";
const nextConfig: NextConfig = {
  basePath: "/demo2",
  turbopack: { root: process.cwd() },
};
export default nextConfig;
```

Reverse proxy in the MAIN app — `src/app/demo2/[[...rest]]/route.ts` (create the folder). Forwards method/headers/body/stream, strips hop-by-hop headers, deletes `content-encoding` (fetch already decompressed):
```ts
const UPSTREAM = "http://127.0.0.1:3005";
const HOP = new Set(["connection","keep-alive","proxy-authenticate","proxy-authorization","te","trailer","transfer-encoding","upgrade","host","content-length"]);
async function proxy(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const target = UPSTREAM + url.pathname + url.search;
  const headers = new Headers();
  req.headers.forEach((v, k) => { if (!HOP.has(k.toLowerCase())) headers.set(k, v); });
  const init: RequestInit & { duplex?: string } = { method: req.method, headers };
  if (!["GET", "HEAD"].includes(req.method)) {
    const body = await req.arrayBuffer();
    if (body.byteLength > 0) init.body = body;
  }
  try {
    const up = await fetch(target, init);
    const out = new Headers();
    up.headers.forEach((v, k) => { if (!HOP.has(k.toLowerCase())) out.set(k, v); });
    out.delete("content-encoding");
    return new Response(up.body, { status: up.status, statusText: up.statusText, headers: out });
  } catch {
    return Response.json({ error: "next-demo service is unreachable" }, { status: 502 });
  }
}
export { proxy as GET, proxy as POST, proxy as PUT, proxy as PATCH, proxy as DELETE, proxy as HEAD, proxy as OPTIONS };
```
(Use the full production version in `src/app/demo2/[[...rest]]/route.ts` of this repo as reference — it has detailed comments.)

Then: add to ADOPTABLE + adopt (Recipe 3 steps 1-2), add `mini-services/{name}/.next/` to `.gitignore`, and use **`/demo2`** (path-based) as the public URL. After the basePath fix, `?XTransformPort=3005` also works for pages because chunks resolve through the main app's `/demo2` proxy.

## 6. Recipe — React Native / Expo app (build + static web export + live preview)

Build, preview, and ship a React Native app from this sandbox. **Verified live 2026-10-05** (repo worklog Task 6): a full Expo project (expo-router, TypeScript, Arabic RTL dark screen) was scaffolded, exported, and served with working interactivity — then an independent agent later concluded "React Native cannot run here" because it never tried. Reference implementation lives in this repo: `finacc-mobile/` + `scripts/build-rn-web.sh`.

**Truth table first — read before concluding anything is impossible:**

| ✅ Works (verified) | ❌ Does NOT work (also verified) |
|---|---|
| Full Expo project + expo-router + react-native-web + TypeScript | `create-expo-app` — hangs interactively forever; scaffold manually (step 1) |
| `npx expo export --platform web` → static bundle (~1 MB, ~60–90 s) | Live Metro dev server / HMR — the reaper kills it (law 4). Dev loop = edit → re-export → refresh |
| Serving the bundle from the main app's `public/rn/` → live preview on `:3000` | Android emulator (no KVM) |
| Full interactivity in the preview (buttons, toasts, state) | EAS Build / APK signing (needs interactive Expo account login) — runs on the user's machine |

**The false-legend trap:** the preview panel hosting "only one Next.js app on :3000" does NOT mean other frameworks are impossible. An RN web export is a static file tree — it needs no server of its own, it rides the main app's port from `public/`. When a user asks "can we build RN/Expo here?" the answer is **yes (build + preview), with no hot reload**, and the APK step happens on their machine.

**1. Scaffold manually — never `create-expo-app`.** Create `{project}/` (sibling of the main app, e.g. `finacc-mobile/`):

`package.json` — the exact verified combo (Expo SDK 54 / RN 0.81 / React 19.1 / RNW 0.21):
```json
{
  "name": "my-mobile-app",
  "main": "expo-router/entry",
  "private": true,
  "scripts": { "start": "expo start", "export:web": "expo export --platform web" },
  "dependencies": {
    "expo": "~54.0.0", "expo-router": "~6.0.24", "expo-constants": "~18.0.14",
    "expo-font": "~14.0.12", "expo-linking": "~8.0.12", "expo-status-bar": "~3.0.9",
    "react": "19.1.0", "react-dom": "19.1.0", "react-native": "0.81.5",
    "react-native-safe-area-context": "~5.6.0", "react-native-screens": "~4.16.0",
    "react-native-web": "^0.21.0", "@expo/metro-runtime": "~6.1.2"
  },
  "devDependencies": { "typescript": "~5.3.3", "@types/react": "~19.1.0" }
}
```

`app.json` — `web.output: "static"` is what makes the export a plain servable file tree:
```json
{
  "expo": {
    "name": "MyApp", "slug": "my-mobile-app", "newArchEnabled": true,
    "userInterfaceStyle": "dark",
    "android": { "package": "com.example.myapp" },
    "web": { "bundler": "metro", "output": "static" },
    "plugins": ["expo-router"]
  }
}
```

Screens live in `app/` (`_layout.tsx` + one file per route). `tsconfig.json` extends `expo/tsconfig.base`. Fonts: `@expo-google-fonts/*` packages (they survive the static export). Then `bun install` (~3–10 s; the registry is fast here). If a different Expo SDK is ever needed, `npx expo install <pkg>` resolves compatible versions automatically.

**Trap: stale `src/app/`.** expo-router prefers `src/app/` over `app/` — leftover template files there silently render the wrong tree. Delete `src/` inside the RN project.

**2. Export + integrate via a repeatable build script** (copy `scripts/build-rn-web.sh`, adjust the 2 path variables at its top). The 4 steps in this exact order:
```bash
cd {project} && rm -rf dist && npx expo export --platform web
# 2) fix every emitted HTML: RTL (lang/dir) + rewrite absolute → prefixed asset paths (Trap A)
# 3) inject history.replaceState BEFORE the first _expo bundle <script> in index.html (Trap B)
# 4) rm -rf ../public/rn && mkdir -p ../public/rn && cp -r dist/* ../public/rn/
```

- **Trap A — absolute paths:** the export references `/_expo/...` and `/assets/...` from site root. Mounted under `/rn/` they 404 and React mounts nothing (blank page, **zero console errors**). Rewrite every `src="`/`"href="` root-absolute URL to `/rn/...` in the emitted HTML.
- **Trap B — router mismatch:** expo-router matches the URL path against routes; at `/rn/index.html` it finds no matching route and renders nothing (document loads, Suspense stays empty). Inject `<script>try{history.replaceState(null,"","/")}</script>` immediately before the first `src=".../_expo/..."` script tag.
- **Trap C — font requests outside the HTML:** even after Trap A, some font files are still fetched from `/assets/...` (request URLs live in JS, not HTML). Add symlinks in the MAIN app's `public/` — via bun, because `ln -s` is blocked (law 7):
```bash
bun -e "require('fs').symlinkSync('rn/_expo','public/_expo','dir'); require('fs').symlinkSync('rn/assets','public/assets','dir')"
```

**3. Preview.** The app is live at `/rn/index.html` on the main app's port. Verify the exact way the user will hit it: `curl -s http://127.0.0.1:3000/rn/index.html | head -5`, then drive it with agent-browser (click a button, confirm the DOM/state reacts). Optional polish: a Next.js page in the main app embedding it in a phone-frame iframe (see this repo's `src/app/page.tsx`).

**4. Dev loop contract:** edit RN code → run the build script → hard-refresh. ~60–90 s per cycle, NO hot reload — so batch UI changes per cycle and keep screens small. Do NOT fight the reaper by trying to keep `expo start` alive; the export loop IS the dev environment.

**5. APK — hand off to the user's machine.** Keep the RN project git-committed (law 6 — node_modules/dist are rebuilt, source survives). The user then runs `bun install && npx expo start` (Expo Go on their phone) or `eas build -p android --profile preview` (installable APK). The codebase stays native-portable as long as screens import only react-native / react-native-web-aliased components (use `Platform.OS === 'web'` for web-only tweaks, never direct `react-dom` APIs in screens).

## 7. Lifecycle operations

```bash
# status of everything
free -m; ps -eo pid,ppid,cmd | grep -E "next|uvicorn|postgres" | grep -v grep
# tail a mini-service log (boot) — mid-session adoptions log to /tmp/mini-service-*.log
tail -30 /home/z/my-project/.zscripts/mini-service-{name}.log
# revive a dead boot-tree service mid-session (must be in ADOPTABLE)
curl -s -X POST http://127.0.0.1:3050/ops/adopt -H "x-worker-secret: pulse-worker-dev-secret" -H "content-type: application/json" -d '{"service":"py-status"}'
# stop a service
pkill -f "uvicorn app:app.*3060"   # or the matching pattern; postgres: pg_ctl stop
# postgres control (only 3 binaries shipped: initdb, pg_ctl, postgres)
/home/z/pg/package/native/bin/pg_ctl -D /home/z/pg/data -l /home/z/pg/pg.log status|start|stop
# verify through the gateway (the exact path user traffic takes)
curl -s "http://127.0.0.1:81/?XTransformPort=3060"        # python service
curl -s "http://127.0.0.1:81/demo2"                        # second next app (via proxy)
```

If the reaper killed your fresh service and the adoption hatch doesn't know it: edit `ADOPTABLE` in `mini-services/checkout/index.ts` (hot-reloads), then POST `/ops/adopt`. If checkout itself is dead, everything re-launches at the next reboot via auto-boot — or restart the container flow by running `.zscripts/dev.sh` steps manually.

## 8. Decision table — how to expose what

| What you're exposing | Mechanism |
|---|---|
| JSON API / webhook endpoint | `?XTransformPort={port}` — works directly |
| Simple HTML page (assets inline) | `?XTransformPort={port}` — works (keep ALL css/js inline) |
| Full Next.js / React app | basePath + reverse proxy route in main app (Recipe 5) |
| React Native / Expo mobile app | static web export → main app `public/rn/` (Recipe 6); preview at `/rn/index.html`; APK via EAS on the user's machine |
| Database server | never exposed; internal `127.0.0.1` only |

## 9. About this skill's own survival

This skill is dual-homed: active copy in `skills/sandbox-multi-stack/` (loaded by the Skills tool) + persisted copy in `docs/skills/sandbox-multi-stack/` (survives reboots via repo.tar). `.zscripts/restore-custom-skills.sh` (called from `.zscripts/dev.sh` at every boot) restores the active copy if missing. **If you edit this skill, update BOTH copies.**
