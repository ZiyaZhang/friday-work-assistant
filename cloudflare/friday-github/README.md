# Friday GitHub transport relay

Independent Worker `friday-github`. This does not modify the OAuth Worker or replace Friday's repository policy/source/approval and effect ledger. Code and synthetic tests alone do not prove a deployed route or real GitHub write succeeded.

With `GITHUB_CREDENTIAL_MODE="worker"`, full `RELAY_TOKEN` requests use the user-configured `GITHUB_READ_TOKEN` secret instead of an older caller credential. The historical secret name is retained; its GitHub scopes may include Contents and Pull requests write. Hosted credentials are restricted to repositories in `ALLOWED_GIT_REPOS`, fixed log/artifact routes for those repositories, and GET `/api/user` for identity. Other paths, including GraphQL, are refused in this mode. API requests use Bearer auth and Git uses Basic auth; redirects never forward these credentials to arbitrary hosts. The PAT is never returned to the Friday host or executor.

The separate `RELAY_READ_TOKEN` remains read-only even when the hosted PAT has write scopes. It supports only read routes and allowlisted Git upload-pack; no API write or Git receive-pack. Missing hosted credentials fail closed. Removing the mode setting restores per-request credential forwarding for the full token.

Routes:

| Incoming route | Fixed upstream | Contract |
| --- | --- | --- |
| `GET /health` | none | Public generic `{ok,version}`; no account/config/secret information |
| `/api/<path>` | `https://api.github.com/<path>` | REST and `/api/graphql`; GET/HEAD/POST/PUT/PATCH/DELETE/OPTIONS, query preserved |
| `GET /logs/<owner>/<repo>/<jobId>` | `https://api.github.com/repos/<owner>/<repo>/actions/jobs/<jobId>/logs` | Fixed Actions job log; bounded byte range through one verified storage redirect, no URL input |
| `GET /git/<owner>/<repo>.git/info/refs?service=git-upload-pack` | same smart-HTTP path at `https://github.com` | Read discovery |
| `GET /git/<owner>/<repo>.git/info/refs?service=git-receive-pack` | same smart-HTTP path at `https://github.com` | Write discovery |
| `POST /git/<owner>/<repo>.git/git-upload-pack` | same path at `https://github.com` | Read negotiation/pack stream; no query |
| `POST /git/<owner>/<repo>.git/git-receive-pack` | same path at `https://github.com` | Push stream; no query |

Every non-health request needs `x-friday-relay-token` matching the `RELAY_TOKEN` Worker secret. Comparison hashes both values and uses [Workers' native timing-safe comparison](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/#timingsafeequal). Use a fresh, strong random secret independent of the OAuth relay. Never put it in a URL, Git remote, committed config or model input.

Git transport additionally requires an exact owner/repo entry in `ALLOWED_GIT_REPOS` (comma or whitespace separated, case-insensitive). Empty or malformed configuration denies Git. Wildcards, prefixes, encoded path separators and alternate Git endpoints are not accepted. This transport allowlist does not authorize a push: the host still needs the actual repository, requester, intended effect and approval.

The current request's GitHub `Authorization` is forwarded only to the fixed destination. The relay token, cookies, forwarding headers, Origin/Referer and arbitrary headers are stripped. Responses allow content type/encoding, conditional-read metadata, pagination Link, rate limits and GitHub request/auth-scope metadata; they do not relay Set-Cookie, Location or credentials. Host clients must map subsequent fixed GitHub API pagination URLs through this same authenticated relay; response links are not rewritten into arbitrary proxy targets.

Ordinary `/api` and Git subrequests use `redirect: manual` and reject redirect responses; this includes all write requests. Conditional GET 304 remains valid. Cloudflare documents that automatic redirects can forward authentication headers to a different hostname: [Request redirect behavior](https://developers.cloudflare.com/workers/runtime-apis/request/).

The only published redirect exception is the fixed read-only `/logs` route. GitHub's [download-job-logs endpoint](https://docs.github.com/en/rest/actions/workflow-jobs#download-job-logs-for-a-workflow-run) returns a 302 to a one-minute plain-text download. The relay validates that destination as HTTPS on the default port, with no userinfo or fragment, and only `results-receiver.actions.githubusercontent.com` or a single-account `*.blob.core.windows.net` host from GitHub's [documented log storage domains](https://docs.github.com/en/actions/reference/runners/github-hosted-runners#communication-requirements-for-github-hosted-runners). Fresh storage requests never carry GitHub Authorization, the relay token, cookies or Referer; any further redirect is rejected. Neither signed URLs nor error bodies are returned.

For `/logs`, the host supplies `x-friday-log-max-bytes` (4–8388608) and optionally `x-friday-log-start-byte` (nonnegative). A missing start requests the tail: the relay first reads range `0-0` for a verified total, then requests an explicit byte interval because [Azure's Range grammar](https://learn.microsoft.com/en-us/rest/api/storageservices/specifying-the-range-header-for-blob-service-operations) does not define suffix ranges. Each response validates Content-Range, actual streamed bytes and cancellation within 30 seconds; responses expose only Content-Range and the numeric start offset. Friday normally returns at most 64KiB/500 lines and uses the larger download bound only for caller-selected literal search. Repository and original PR/check/job/source authorization remain on the host. This route neither adds credentials nor grants repository access.

Bodies stream unchanged in both directions; packfiles and JSON are not buffered, inspected, stored or logged. `cache: no-store` bypasses the upstream fetch cache and every response sends `Cache-Control: no-store`. No Cache API, D1, KV, queues, `waitUntil`, retry loop or console logging is used. Worker observability is disabled in Wrangler. [Cloudflare streaming behavior](https://developers.cloudflare.com/workers/runtime-apis/streams/) and [cache/compression behavior](https://developers.cloudflare.com/workers/runtime-apis/fetch/) explain the stream pass-through used here.

The original request signal is passed to fetch. Wrangler explicitly enables [incoming request signals and signal pass-through](https://developers.cloudflare.com/workers/configuration/compatibility-flags/). A canceled request yields a generic 499 if the response has not started; transport failure yields generic 502. No retry is performed. Cancellation cannot undo an Issue, PR or push GitHub already accepted: the Friday host must keep an unknown effect receipt and inspect GitHub before any further write.

Configuration and release, when authorized by the release owner:

```sh
cd cloudflare/friday-github
npx --yes wrangler@4 secret put RELAY_TOKEN
npx --yes wrangler@4 deploy
```

These commands target this Worker only. Provide secrets through the protected prompt, not a shell command argument. `workers_dev = true` requests the account's Workers subdomain; verify the actual returned URL rather than assuming deployment exists. For hosted credential mode, set `GITHUB_READ_TOKEN` with `wrangler secret put`; never print its value or put it in config or a URL.

Host configuration is explicit and chosen before any request. Set `FRIDAY_GITHUB_RELAY_URL` to the deployed HTTPS origin and `FRIDAY_GITHUB_RELAY_TOKEN` to the same independent secret; both must be present. The host still uses its existing configured GitHub proxy to reach the Worker when its network requires it. Existing direct GitHub change bindings remain registered unchanged, but trusted network operations use the configured relay. A relay failure never retries through direct GitHub.

Before deployment, run `npx vitest run test/github-relay-worker.test.ts test/github-job-log-download.test.ts test/github-pr-check-evidence.test.ts` from the repository root. Tests use native Web streams, a shim for Workers' timingSafeEqual, and real local TLS/CONNECT fixtures; actual Cloudflare/GitHub cancellation, job log retrieval, API writes, Git fetch/push and exact PR update still require separate real acceptance. The supported Git transport follows [Git's smart HTTP protocol](https://git-scm.com/docs/http-protocol); SSH, LFS and arbitrary upload/download hosts are outside this relay.
