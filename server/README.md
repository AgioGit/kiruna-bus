# Boreal bus server

Dependency-free Node server (Node 20+) that sits between the browser and the
Boreal AnyRide API. Boreal sends no CORS headers, so browsers can't call it
directly; this server calls it instead, caches the results, and also serves
the frontend from `../src`.

```powershell
node index.js        # http://localhost:8080/
node --test          # unit tests
```

## Endpoints

| Path | Description |
|---|---|
| `/api/buses` | Every running bus: position, line, destination, next two stops with planned/forecast times, age and stale flag, plus `lineRoutes` (`{ lineId: routeId[] }`). `502` with `{error}` if there is no data at all. |
| `/api/stops` | `[{ id, text, location }]` for every stop. |
| `/api/health` | Liveness plus tracker status (journey count, last scan, last error). |
| `/api/<Endpoint>` | Cached passthrough for the Boreal endpoints the frontend uses (`GetConfigOptions`, `GetLines`, `GetDirections`, `GetStopAreas`, `GetCalls`, `GetMapRoute`, `GetVehiclePosition(s)`, `GetSystemTimestamp`, `Autocomplete`, `FindStopArea`, `FindStopsNearLocation`). Profile headers are added server-side; responses carry `X-Cache: HIT/MISS/BYPASS`. |
| everything else | Static files from `STATIC_DIR`. |

## How it limits load on Boreal

There are no background timers. Boreal is contacted only when a request
arrives and the data is older than its TTL, and concurrent requests share one
refresh, so upstream traffic is independent of the number of visitors (and
zero when nobody is looking).

- Stop scan (`GetCalls` for every stop): every ~3 minutes, earlier (but not
  within 30 s of the last scan) if a position fetch fails.
- Vehicle positions: at most every 15 s.
- Passthrough TTLs: `GetCalls` 30 s, `GetVehiclePosition(s)` 15 s, static-ish
  data (config, lines, stops, routes) 1 h.
- Missing positions keep their last known fix with its original GPS timestamp
  and are marked stale. This also covers journeys disappearing from a scan
  or changing call ids. Fixes older than three minutes are omitted.
  If Boreal is down, the response carries an `error`.

## Configuration (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | Listen port. |
| `HOST` | `0.0.0.0` | Listen address. |
| `ALLOWED_ORIGINS` | `https://mhedqvist.github.io` | Comma-separated origins allowed to call `/api` cross-origin (`*` for all). The bundled frontend is same-origin and needs none. |
| `STATIC_DIR` | `../src` | Frontend directory; `off` for an API-only server. |
| `BOREAL_BASE` | Boreal AnyRide API URL | Upstream base URL. |
| `BOREAL_PROFILE_DATA` | `boreal_kiruna` | `anyride-profile-data` header. |
| `BOREAL_PROFILE_DISPLAY` | `boreal` | `anyride-profile-display` header. |
| `UPSTREAM_TIMEOUT_MS` | `10000` | Per-request timeout towards Boreal. |

## Deploying

Run it anywhere Node 20+ runs (Azure App Service, a VM, Railway, Fly.io,
Render, ...): `node server/index.js` with `PORT` set by the host. The server
must be deployed together with `src/`, or set `STATIC_DIR`.

Docker, from the repository root:

```powershell
docker build -f server/Dockerfile -t boreal-bus .
docker run -p 8080:8080 boreal-bus
```

### Azure Container Apps

`.github/workflows/image.yml` builds and pushes `ghcr.io/<owner>/boreal-bus`
on every push to `main` (the package must be public so Azure can pull it).
One-time setup, then redeploy by pointing the app at the new image:

```powershell
az extension add --name containerapp
az provider register -n Microsoft.App --wait
az group create -n rg-boreal-bus -l swedencentral
az containerapp env create -n cae-boreal-bus -g rg-boreal-bus -l swedencentral
az containerapp create -n boreal-bus -g rg-boreal-bus --environment cae-boreal-bus `
  --image ghcr.io/mhedqvist/boreal-bus:latest --target-port 8080 --ingress external `
  --min-replicas 0 --max-replicas 1 --cpu 0.25 --memory 0.5Gi --env-vars PORT=8080

# after a new image is built
az containerapp update -n boreal-bus -g rg-boreal-bus --image ghcr.io/mhedqvist/boreal-bus:latest `
  --revision-suffix r$(Get-Date -Format yyyyMMddHHmm)
```

Scale-to-zero means the first request after idle time waits for a cold start
(a few seconds plus the initial Boreal scan).

Keep a single instance (or accept one cache per instance); the in-memory
caches are not shared. The first request after a cold start takes a few
seconds because the server scans all stops; it warms up on boot to hide this.

To keep the page on another host (e.g. GitHub Pages), set `apiBase` in
`src/runtime-config.js` to `https://<your-server>/api` and add the page's
origin to `ALLOWED_ORIGINS`.
