# mcp-swarmpit

MCP server that wraps the Swarmpit REST API so MCP clients (Claude Code, opencode, etc.) can manage Docker Swarm clusters. Runs locally over stdio, holds the API token in its own process environment — tokens never enter the LLM conversation context.

## Architecture

```
src/
  index.ts           — entry: load config, startup health check, register tools, connect stdio
  config.ts          — SwarmpitConfig + redact mode loaded from env (SWARMPIT_URL/TOKEN/REDACT/REDACT_PATTERNS)
  client.ts          — SwarmpitClient: typed HTTP methods per API endpoint (native fetch)
  sanitize.ts        — redaction utilities for services, compose YAML; $env: resolver; [REDACTED] round-trip
  types.ts           — TypeScript types for Swarmpit API responses
  tools/
    register.ts      — wires all tool registrations, creates single SwarmpitClient instance
    helpers.ts       — toolResult/toolError, resolveEnvRef, resolveData ($env/$file), prepareServiceForUpdate
    services.ts      — list/get/create/update/redeploy/rollback/stop/scale/delete + env management
    stacks.ts        — list/get/create/update/redeploy/rollback/deactivate/delete + stack-file variants
    networks.ts      — list/get/create/delete + services-using
    nodes.ts         — list/get/get_tasks/edit/delete
    tasks.ts         — list/get
    volumes.ts       — list/get/create/delete + services-using
    secrets.ts       — list/get (redacted)/create ($env/$file)/delete + services-using
    configs.ts       — list/get (redacted)/create ($env/$file)/delete + services-using
    admin.ts         — list/get/create/edit/delete users
    dashboard.ts     — pin/unpin node or service
    timeseries.ts    — nodes/services cpu/memory/task metrics
    util.ts          — swarmpit_info
  test/              — node:test suites (run `npm test`)
swagger.json         — saved from a running Swarmpit instance for reference
```

Tools are each under ~50 lines, all follow the same pattern: zod input schema, try/catch, `toolResult` or `toolError`. Full API coverage (79/79 non-timeseries endpoints + all timeseries/dashboard/admin).

## Build & test

- Node >= 18, TypeScript, ES modules (`"type": "module"`)
- `npm run build` — compile to `dist/`
- `npm run dev` — watch mode
- `npm test` — runs `tsc` (`pretest`) then `node --test dist/test/*.test.js`

Tests use Node's built-in test runner. Pattern for integration tests (see `test/file-ref.test.ts`): hand-rolled mock server that captures handlers registered via `server.tool(...)`, plus a mock client that records calls. Invoke the handler directly, assert on captured arguments. Avoids the MCP transport layer entirely.

## Configuration

Three env vars drive the server, loaded by `config.ts`:

| Env | Required | Notes |
|-----|----------|-------|
| `SWARMPIT_URL` | Yes | Base URL, trailing slashes stripped |
| `SWARMPIT_TOKEN` | Yes | Accepts with or without `Bearer ` prefix |
| `SWARMPIT_REDACT` | No | `all` (default), `sensitive`, `none` |
| `SWARMPIT_REDACT_PATTERNS` | No | Comma-separated extra regex patterns for sensitive mode |

Config validation runs at startup; fatal errors exit with a message. Immediately after, `checkConnection()` calls `listNodes()` to verify auth and warn (not fail) if the token is wrong.

## Security model — secrets never in LLM context

Three layers keep user secrets out of the conversation:

1. **Response sanitization** (`sanitize.ts`)
   - `sanitizeService`: env var values replaced with `[REDACTED]`. `all` redacts all, `sensitive` matches name patterns (`pass`, `secret`, `token`, `key`, `auth`, `credential`, `private`, `dsn`, `connection.?string`) + user-provided `SWARMPIT_REDACT_PATTERNS`.
   - `sanitizeComposeYaml`: same redaction applied to YAML env vars (both `KEY: val` and `- KEY=val` forms).
   - Secrets/configs `data` field zeroed unless mode is `none`.

2. **`$env:` / `$file` references in tool inputs** (`helpers.ts::resolveEnvRef`, `resolveData`)
   - `update_service_env` accepts `{ $env: "MY_SECRET" }` per-var — resolved from `process.env` server-side.
   - `create_stack` / `update_stack` / `create_stack_file` accept YAML with `$env:VAR_NAME` tokens (string or `{ $file: /path }`) — `resolveComposeEnvRefs` replaces them before sending.
   - `create_secret` / `create_config` accept `{ $file: /path }` to read payload from disk (saves thousands of tokens on HTML pages, certs, large compose files).

3. **`[REDACTED]` round-trip on stack update** (`sanitize.ts::restoreRedactedValues`)
   - `get_stack` returns compose with sensitive values as `[REDACTED]`.
   - `update_stack` fetches the current raw compose, restores `[REDACTED]` values from it, then applies `$env:` resolution. Lets the user edit only what they need without accidentally overwriting secrets.

4. **`SWARMPIT_TOKEN_FILE` to keep the token out of MCP client configs** (`config.ts::loadToken`)
   - If `SWARMPIT_TOKEN_FILE` is set, token is read from the referenced path at startup. Takes precedence over `SWARMPIT_TOKEN`.
   - Matters because Claude Code and similar clients can accidentally dump `.mcp.json` (with inlined `SWARMPIT_TOKEN`) to conversation via their `Read` tool. Users are directed to add a `permissions.deny` rule on `.mcp.json` and use `SWARMPIT_TOKEN_FILE` — see README "Token handling".

If you add a new tool that takes user-provided data, use `resolveData` (supports plain string, `$env`, `$file`) instead of accepting raw strings for any non-trivial payload.

## Swarmpit API quirks (learned the hard way)

Real Swarmpit behaviour diverges from its own Swagger spec in several places. Keep these in mind if you extend the client:

- **`POST /api/secrets` and `/api/configs` want base64** — the Swagger types `data: string` but the server rejects raw strings with `invalid JSON: illegal base64 data at input byte 0`. `client.ts` encodes on the way in. Not yet filed upstream.

- **`GET /api/services/{id}/logs` requires `since`** as a Go duration string (`30s`, `5m`, `1h`), NOT a unix timestamp or ISO 8601. Default in the client is `5m`. Filed [swarmpit#730](https://github.com/swarmpit/swarmpit/issues/730) for the lack of documentation (closed).

- **Nested `{ spec: { compose } }`** — `getStackFile`, `getStackCompose`, `getServiceCompose` all wrap the compose string under `spec.compose`, but the swagger types it as flat `{ compose: string }`. The client normalises to `{ compose }`. Don't trust the swagger. (I initially filed [swarmpit#729](https://github.com/swarmpit/swarmpit/issues/729) thinking the endpoint was broken — it wasn't, just poorly documented.)

- **Service edit used to reject its own GET response** — [swarmpit#724](https://github.com/swarmpit/swarmpit/issues/724) (now fixed): `POST /api/services/{id}` complained about `imageDigest` being empty (`"nginx:alpine@"`). `prepareServiceForUpdate()` in `helpers.ts` strips nulls, strips read-only fields (`id`, `createdAt`, `updatedAt`, `state`, `status`), and trims `repository` to `{ name, tag }`. Keep this logic — even if the server bug is fixed, the read-only fields and nulls still cause issues.

- **`POST /api/stacks/{name}` edit wants `name` in the body** — not just the path param. `updateStack()` adds it automatically.

- **Timeseries endpoints (`/api/nodes/ts`, `/api/services/ts/cpu|memory`, `/api/tasks/{name}/ts`) return huge payloads** — often >100KB. Use the tools sparingly or expect token truncation in clients.

## Adding a new tool

1. Add a typed method to `SwarmpitClient` (`client.ts`) — use `this.request<T>(method, path, body?)`.
2. Add a registration function in a resource file under `tools/` (follow the shape of existing ones).
3. Wire it in `tools/register.ts` alongside the others.
4. If it accepts user data that could be large or sensitive, accept `string | { $env } | { $file }` and call `resolveData` first.
5. If it returns data that could contain secrets, pass it through the appropriate sanitizer. Respect the `redact` mode.
6. If it's destructive (`DELETE`, data loss), require `confirm: z.boolean()` and return a `toolError` if not set.
7. Add tests: unit test for any new sanitizer logic, integration test using the mock-server pattern if it touches `$file`/`$env`/redaction.

## Publishing / distribution

Not on npm (yet) — users install via `npx github:swarmpit/mcp` in their MCP client's config. Works because `package.json` has a `bin` entry pointing at `dist/index.js` and npm installs fetch+build on first run. If we publish to npm later, just flip the `mcp-swarmpit` name for `@swarmpit/mcp` and add `publishConfig.access: public`.

## Useful commands

```bash
# Hit the live Swarmpit API directly (bypassing the MCP) to debug:
curl -s -H "Authorization: Bearer $SWARMPIT_TOKEN" "$SWARMPIT_URL/api/services" | jq .

# Re-fetch the swagger from a running Swarmpit (helps when API diverges from local copy):
curl -s $SWARMPIT_URL/api/swagger.json > swagger.json

# List all endpoints from swagger:
jq -r '.paths | to_entries[] | .key as $p | .value | keys[] | "\(. | ascii_upcase)\t\($p)"' swagger.json | sort
```

## Style / conventions

- Keep commit messages lowercase and succinct (`fix X`, `support $file refs for stack compose`) — no AI/Claude/Anthropic references, no Co-Authored-By.
- Only push on explicit user request.
- No code comments for the "what" — names should carry it. Comments only when the "why" is non-obvious (e.g. the base64 encoding workaround, nested `spec.compose` normalisation).
