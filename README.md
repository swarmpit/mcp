# mcp-swarmpit

MCP server for managing [Swarmpit](https://swarmpit.io) Docker Swarm instances from any MCP-compatible client. 100% Swarmpit API coverage (79 endpoints).

The server runs locally and holds API tokens — they never enter the LLM conversation context.

Works with [opencode](https://opencode.ai) (recommended), [Claude Code](https://claude.ai/code), and any other MCP client.

## Configuration

### opencode

Add to your `.opencode.json`:

```json
{
  "mcpServers": {
    "swarmpit-prod": {
      "type": "stdio",
      "command": "npx",
      "args": ["github:swarmpit/mcp"],
      "env": {
        "SWARMPIT_URL": "https://swarmpit.example.com",
        "SWARMPIT_TOKEN": "your-api-token",
        "SWARMPIT_REDACT": "sensitive"
      }
    }
  }
}
```

### Claude Code

Add to your `.mcp.json` (project-level) or `~/.claude.json` (global):

```json
{
  "mcpServers": {
    "swarmpit-prod": {
      "command": "npx",
      "args": ["github:swarmpit/mcp"],
      "env": {
        "SWARMPIT_URL": "https://swarmpit.example.com",
        "SWARMPIT_TOKEN": "your-api-token",
        "SWARMPIT_REDACT": "sensitive"
      }
    }
  }
}
```

Get your API token from Swarmpit UI: Profile → API Access → Generate token.

### Multiple instances

One process can manage several Swarmpit instances. Every tool then takes an optional `server` argument naming the target — the tool set is registered once instead of once per instance, which matters because the full surface is ~79 tools and the model loads all of them for every MCP server you wire up.

Point `SWARMPIT_CONFIG_FILE` at a JSON file:

```json
{
  "default": "prod-eu",
  "servers": {
    "prod-eu": { "url": "https://swarmpit.eu.example.com", "tokenFile": "~/.config/swarmpit/prod-eu" },
    "prod-us": { "url": "https://swarmpit.us.example.com", "tokenFile": "~/.config/swarmpit/prod-us" }
  }
}
```

```json
{
  "mcpServers": {
    "swarmpit": {
      "command": "npx",
      "args": ["github:swarmpit/mcp"],
      "env": { "SWARMPIT_CONFIG_FILE": "~/.config/swarmpit/servers.json", "SWARMPIT_REDACT": "sensitive" }
    }
  }
}
```

Or without a file, using per-name env vars (`SWARMPIT_<NAME>_URL`, with `-` becoming `_` and the name upper-cased):

```json
"env": {
  "SWARMPIT_SERVERS": "prod-eu,prod-us",
  "SWARMPIT_DEFAULT_SERVER": "prod-eu",
  "SWARMPIT_PROD_EU_URL": "https://swarmpit.eu.example.com",
  "SWARMPIT_PROD_EU_TOKEN_FILE": "~/.config/swarmpit/prod-eu",
  "SWARMPIT_PROD_US_URL": "https://swarmpit.us.example.com",
  "SWARMPIT_PROD_US_TOKEN_FILE": "~/.config/swarmpit/prod-us"
}
```

Then: `list_services({ server: "prod-us" })`. Omitting `server` uses the default. If several instances are configured and no default is set, the argument is required — a forgotten argument will never silently pick a cluster for you. `swarmpit_info` lists what's configured.

#### Querying several instances at once

Read-only tools also accept `"*"` or a list of names, and return results grouped by server:

```jsonc
// list_services({ server: "*" })
{
  "queried": ["prod-eu", "prod-us"],
  "results": {
    "prod-eu": [ { "serviceName": "api", ... } ],
    "prod-us": [ { "serviceName": "api", ... } ]
  }
}
```

Useful for "which cluster runs this service?", comparing an image tag across regions, or checking whether a config exists everywhere — one tool call instead of one per cluster.

- **Reads only.** `list_*`, `get_*` and `service_logs` accept fan-out. Every mutating tool (`create_*`, `update_*`, `delete_*`, `scale_*`, `redeploy_*`, `rollback_*`, `stop_*`, `deactivate_*`, `pin_*`/`unpin_*`, `edit_*`) takes a single name only — "apply this to every cluster" should not be expressible by accident.
- **Partial failure is reported, not fatal.** An unreachable cluster, or one where the named resource doesn't exist, comes back as `{ "error": "..." }` under its own key and is listed in `failed`. The other clusters' results still arrive.
- Passing `"*"` or a list always returns the grouped shape, even if it resolves to one server; passing a bare name returns the plain result.

#### Which pattern to use

**Consolidate within a trust tier, isolate across tiers.**

- **One MCP server, several instances** — the default for instances in the same trust tier (several prod clusters, several staging clusters). This is where the duplicated tool schemas actually cost you.
- **Separate MCP servers** — the right answer *across* trust tiers. Keeping prod in its own process means a test or play conversation cannot reach the prod token at all, no matter what the model is talked into. That is a stronger guarantee than a `server` argument the model chooses itself.

The two compose. One MCP server holding every prod cluster, a second holding every test cluster, gets you both the schema saving and a real boundary where it matters:

```json
{
  "mcpServers": {
    "swarmpit-prod": {
      "command": "npx",
      "args": ["github:swarmpit/mcp"],
      "env": { "SWARMPIT_CONFIG_FILE": "~/.config/swarmpit/prod.json", "SWARMPIT_REDACT": "sensitive" }
    },
    "swarmpit-test": {
      "command": "npx",
      "args": ["github:swarmpit/mcp"],
      "env": { "SWARMPIT_CONFIG_FILE": "~/.config/swarmpit/test.json", "SWARMPIT_REDACT": "none" }
    }
  }
}
```

A single-instance setup is unchanged in every respect: `SWARMPIT_URL` + `SWARMPIT_TOKEN`/`SWARMPIT_TOKEN_FILE` still work, and no `server` argument is added to any tool.

### Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SWARMPIT_URL` | Yes¹ | Swarmpit instance URL (single-instance setup) |
| `SWARMPIT_TOKEN` | One of¹ | API token (with or without `Bearer ` prefix). Avoid putting in `.mcp.json` — see [token handling](#token-handling). |
| `SWARMPIT_TOKEN_FILE` | One of¹ | Path to a file containing the token. Takes precedence over `SWARMPIT_TOKEN`. **Recommended** for production use. |
| `SWARMPIT_CONFIG_FILE` | Yes¹ | Path to a JSON file defining several instances. Takes precedence over everything below. |
| `SWARMPIT_SERVERS` | Yes¹ | Comma-separated instance names, each configured via `SWARMPIT_<NAME>_URL` and `SWARMPIT_<NAME>_TOKEN`/`_TOKEN_FILE` |
| `SWARMPIT_DEFAULT_SERVER` | No | Instance used when a tool call omits `server`. Without it, the argument is required. |
| `SWARMPIT_REDACT` | No | Redaction mode: `all` (default), `sensitive`, or `none`. Applies to all instances in the process. |
| `SWARMPIT_REDACT_PATTERNS` | No | Comma-separated extra patterns to redact in `sensitive` mode (regex, case-insensitive) |

¹ Exactly one of the three forms: `SWARMPIT_CONFIG_FILE`, `SWARMPIT_SERVERS`, or `SWARMPIT_URL`. They are tried in that order.

### Redaction modes

| Mode | Env vars | Secrets/Configs data | User records |
|------|----------|---------------------|--------------|
| `all` | All values redacted | Redacted | Identity only (`_id`, `username`, `role`, `email`) |
| `sensitive` | Only names matching patterns | Redacted | Identity only |
| `none` | No redaction | Not redacted | Full record |

User records never contain a password hash (the Swarmpit server strips it), but in the non-`none` modes the API-token metadata (`jti`, `mask`) and CouchDB `_rev` are dropped too — `list_users`/`get_user` report only `hasApiToken: true`.

The same mode applies to `get_service_env`, compose exports, nested services in `list_stacks`, and all services-using-resource tools. Requesting a variable by name does not bypass redaction. Compose sanitization parses YAML, including quoted/lowercase keys, flow syntax, multiline values, and anchors; comments are omitted from sanitized output. Invalid or unsafe YAML is refused without returning source excerpts.

API errors report HTTP status and recognized field/type diagnostics, not rejected values, unknown predicates, or raw response bodies. This also protects secrets resolved through `$env`/`$file` when a write fails. Inspect server logs locally for additional diagnostics.

> **Warning:** `none` mode sends all environment variables, secrets, and config data in full to the LLM provider. Only use this with a local model (e.g. via ollama/opencode) or on servers that definitely do not contain any sensitive environment variables or configs. Never use `none` with cloud-hosted LLM providers on production infrastructure.

Built-in sensitive patterns: `pass`, `secret`, `token`, `key`, `auth`, `credential`, `private`, `dsn`, `connection_string`.

Add custom patterns via `SWARMPIT_REDACT_PATTERNS`:

```json
"env": {
  "SWARMPIT_REDACT": "sensitive",
  "SWARMPIT_REDACT_PATTERNS": "GRAFANA,RPC,ENDPOINT,DATABASE"
}
```

## Tools

### Services

| Tool | Description |
|------|-------------|
| `list_services` | List all services |
| `get_service` | Get service details |
| `service_logs` | Get service logs |
| `create_service` | Create a service |
| `update_service` | Update a service |
| `redeploy_service` | Redeploy (optionally with new tag) |
| `rollback_service` | Rollback to previous version |
| `stop_service` | Stop a service |
| `scale_service` | Scale replicas |
| `list_service_tasks` | List service tasks/containers |
| `delete_service` | Delete (requires `confirm: true`) |
| `update_service_env` | Set/remove env vars (supports `$env` references) |
| `get_service_env` | Get specific env var values by name |
| `get_service_compose` | Get compose YAML for a service |
| `get_service_networks` | Get networks attached to a service |

### Stacks

| Tool | Description |
|------|-------------|
| `list_stacks` | List all stacks |
| `get_stack` | Get stack services and compose file |
| `create_stack` | Create from compose YAML |
| `update_stack` | Update with new compose YAML |
| `redeploy_stack` | Redeploy all services |
| `rollback_stack` | Rollback all services |
| `deactivate_stack` | Stop all services in a stack |
| `delete_stack` | Delete (requires `confirm: true`) |
| `get_stack_tasks` | List all tasks in a stack |
| `get_stack_volumes` | List all volumes in a stack |
| `get_stack_networks` | List all networks in a stack |
| `get_stack_compose` | Get generated compose YAML |
| `get_stack_secrets` | List secrets in a stack |
| `get_stack_configs` | List configs in a stack |
| `create_stack_file` | Upload a compose file for a stack |
| `delete_stack_file` | Delete stack compose file (requires `confirm: true`) |

### Networks

| Tool | Description |
|------|-------------|
| `list_networks` | List all networks |
| `get_network` | Get network details |
| `create_network` | Create a network |
| `delete_network` | Delete (requires `confirm: true`) |
| `get_network_services` | List services using a network |

### Nodes

| Tool | Description |
|------|-------------|
| `list_nodes` | List all nodes |
| `get_node` | Get node details |
| `get_node_tasks` | List tasks running on a node |
| `edit_node` | Edit node properties |
| `delete_node` | Remove a node (requires `confirm: true`) |

### Tasks

| Tool | Description |
|------|-------------|
| `list_tasks` | List all tasks |
| `get_task` | Get task details |

### Volumes

| Tool | Description |
|------|-------------|
| `list_volumes` | List all volumes |
| `get_volume` | Get volume details |
| `create_volume` | Create a volume |
| `delete_volume` | Delete (requires `confirm: true`) |
| `get_volume_services` | List services using a volume |

### Secrets

| Tool | Description |
|------|-------------|
| `list_secrets` | List all secrets (data redacted) |
| `get_secret` | Get secret details (data redacted) |
| `create_secret` | Create a secret (supports `$env` / `$file` references) |
| `delete_secret` | Delete (requires `confirm: true`) |
| `get_secret_services` | List services using a secret |

### Configs

| Tool | Description |
|------|-------------|
| `list_configs` | List all configs (data redacted) |
| `get_config` | Get config details (data redacted) |
| `create_config` | Create a config (supports `$env` / `$file` references) |
| `delete_config` | Delete (requires `confirm: true`) |
| `get_config_services` | List services using a config |

### Admin

| Tool | Description |
|------|-------------|
| `list_users` | List all Swarmpit users (redacted) |
| `get_user` | Get user details (redacted) |
| `create_user` | Create a user (password accepts `$env`/`$file`) |
| `edit_user` | Edit role and/or email; password changes are rejected |
| `delete_user` | Delete (requires `confirm: true`) |

When creating a user, pass the password by reference so the plaintext never enters the conversation or the tool-call transcript:

```json
{ "username": "svc", "role": "user", "password": { "$env": "NEW_USER_PASSWORD" } }
```

`{ "$file": "/path/to/password" }` works too. A literal string is still accepted, but it is recorded verbatim in the model's context and in the session transcript.

`edit_user` accepts only `spec.role` and `spec.email` and fetches required user metadata locally. The upstream edit endpoint ignores passwords, so the tool refuses password changes instead of reporting a successful rotation. Use Swarmpit's supported password-change workflow separately.

### Dashboard

| Tool | Description |
|------|-------------|
| `pin_service_to_dashboard` | Pin a service to the Swarmpit dashboard |
| `unpin_service_from_dashboard` | Remove a service from the dashboard |
| `pin_node_to_dashboard` | Pin a node to the dashboard |
| `unpin_node_from_dashboard` | Remove a node from the dashboard |

### Timeseries

| Tool | Description |
|------|-------------|
| `get_nodes_timeseries` | Node CPU/memory/disk over time |
| `get_services_cpu_timeseries` | Service CPU usage over time |
| `get_services_memory_timeseries` | Service memory usage over time |
| `get_task_timeseries` | Task metrics over time |

### Utility

| Tool | Description |
|------|-------------|
| `swarmpit_info` | Show connected URL and redaction mode |

## Token handling

Putting `SWARMPIT_TOKEN` directly in `.mcp.json` is convenient but risky: if anything (including Claude / the LLM) reads `.mcp.json`, the token leaks into the conversation and API logs. **Two hardening steps you should take:**

### 1. Block MCP config files from being read

Add this to your project `.claude/settings.json` so Claude Code refuses to `Read` credential-holding files:

```json
{
  "permissions": {
    "deny": [
      "Read(.mcp.json)",
      "Read(**/.mcp.json)",
      "Read(.env)",
      "Read(.env.*)",
      "Read(**/.env)",
      "Read(**/.env.*)",
      "Read(**/*credentials*)",
      "Read(**/secrets/**)",
      "Read(**/*.pem)",
      "Read(**/*.key)"
    ]
  }
}
```

### 2. Use `SWARMPIT_TOKEN_FILE` instead of inline

Store the token in a file outside the repo and reference it by path. The token never appears in `.mcp.json` itself:

```bash
# Write the token to a restricted file
install -m 600 /dev/stdin ~/.config/swarmpit/lark.token <<<'your-token-here'
```

```json
{
  "mcpServers": {
    "swarmpit-lark": {
      "command": "npx",
      "args": ["github:swarmpit/mcp"],
      "env": {
        "SWARMPIT_URL": "https://swarmpit.example.com",
        "SWARMPIT_TOKEN_FILE": "/Users/you/.config/swarmpit/lark.token",
        "SWARMPIT_REDACT": "sensitive"
      }
    }
  }
}
```

### 3. Password manager integration

For even stronger posture, have the MCP spawn with a secret manager:

```json
{
  "swarmpit-lark": {
    "command": "op",
    "args": ["run", "--", "npx", "github:swarmpit/mcp"],
    "env": {
      "SWARMPIT_URL": "https://swarmpit.example.com",
      "SWARMPIT_TOKEN": "op://Private/Swarmpit Lark/token",
      "SWARMPIT_REDACT": "sensitive"
    }
  }
}
```

1Password's `op run` substitutes `op://...` references at process start. macOS users can do the equivalent with `security find-generic-password` in a wrapper script.

If your token has already been exposed (e.g. you saw it scroll through a log), rotate it in Swarmpit UI → Profile → API Access → regenerate.

## Secret handling

Secrets in `.mcp.json` `env` are passed to the MCP server process but **never sent to the LLM**.

### Reading from local files

For large payloads (HTML pages, compose files, certs) use `$file` to have the MCP server read from disk instead of passing content through the LLM context:

```
create_config(configName: "my_dashboard", data: { "$file": "/path/to/index.html" })
create_secret(secretName: "tls_cert", data: { "$file": "/etc/ssl/server.crt" })
create_stack(name: "myapp", compose: { "$file": "/path/to/stack.yml" })
update_stack(name: "myapp", compose: { "$file": "/path/to/stack.yml" })
```

Saves context/credits on anything larger than a few hundred bytes. `$env:` references inside the file are still resolved before sending to Swarmpit.

### Service env vars

Use `$env` references to set secrets without them entering the conversation:

```
update_service_env(id: "my-service", set: {
  "NODE_ENV": "production",
  "DB_PASSWORD": { "$env": "MY_DB_PASS" }
})
```

`MY_DB_PASS` is resolved from the MCP server's environment. Add it to `.mcp.json` env:

```json
"env": {
  "SWARMPIT_URL": "...",
  "SWARMPIT_TOKEN": "...",
  "MY_DB_PASS": "the-actual-password"
}
```

### Stack compose files

When reading stacks, env var values are redacted according to the redaction mode. When updating, `[REDACTED]` values are automatically preserved from the current stack — only changed values are updated:

```yaml
# Returned by get_stack (sensitive mode):
environment:
  NODE_ENV: production           # visible
  DB_PASSWORD: "[REDACTED]"      # redacted

# Sent to update_stack — only NODE_ENV changed:
environment:
  NODE_ENV: staging              # new value
  DB_PASSWORD: "[REDACTED]"      # preserved from current stack
```

Use `$env:VAR_NAME` for new secrets in compose:

```yaml
environment:
  NEW_SECRET: $env:MY_SECRET     # resolved locally
```

References may be quoted and used in map or `KEY=$env:VAR_NAME` list form. Resolved values remain strings, including empty strings, numbers, comments, quotes, and newlines. Dollar signs in locally resolved values are escaped for Docker so they stay literal. Missing or partial references are refused; use `$$env:NAME` for an intentional literal `$env:NAME`.

Preserved values are read from the **live service state**, not the stored stack file — the two diverge whenever a var is changed through `update_service_env` or the Swarmpit UI. If they disagree for a var being restored, `update_stack` says so in its result.

An unavailable live compose aborts both updates and previews. A missing stored file (HTTP 404) is allowed if the live state supplies the values; other read failures or malformed restoration sources abort. Shared anchors and merges are expanded before restoration so each service keeps its own live values, even when they differ. Redacted top-level `x-` templates are removed after their consumers are inlined, preventing unused copies of obsolete credentials; unrelated extension metadata is kept. Formatting and comments may change when placeholders are restored.

Restoration is structural: each placeholder is filled from the **same service and key** (or the same path outside `services`), so two services sharing a name like `ALERT_WEBHOOK` each keep their own value. Quoted (`'[REDACTED]'`, `"[REDACTED]"`), list (`- KEY=[REDACTED]`, `- "KEY=[REDACTED]"`) and commented forms all work. A placeholder that neither the live state nor the stack file can fill makes `update_stack` refuse the write (and `dry_run` reports it) instead of shipping the literal string.

### Service specs

`update_service` applies the same protection: any env var left as `[REDACTED]` is restored from the live service before the write, so a `get_service` → edit one field → `update_service` round-trip can't overwrite secrets with the placeholder. Restored names are listed in the result as `restoredVars`.
A `[REDACTED]` variable the live service doesn't have is refused rather than written.

As a last line of defence the client never sends a write request whose body contains `[REDACTED]`, whichever tool built it.

### Previewing a write

`update_service` and `update_stack` take `dry_run: true`, which computes everything — `[REDACTED]` restoration, `$env:` resolution, null normalisation — and reports what *would* change without sending it:

```jsonc
// update_service({ id, spec, dry_run: true })
{
  "dryRun": true,
  "restoredVars": ["RPC_URL"],
  "changes": {
    "fields": { "replicas": { "from": 1, "to": 3 } },
    "variables": { "changed": ["LOG_LEVEL"], "added": ["NEW"], "removed": ["OLD"], "unchanged": 4 }
  }
}
```

For stacks the diff is **semantic, not line-based** — the two composes are parsed and compared service by service:

```jsonc
// update_stack({ name, compose, dry_run: true })
{
  "dryRun": true,
  "changes": {
    "changed": true,
    "services": {
      "added": ["cache"],
      "removed": ["worker"],
      "changed": {
        "web": {
          "image": { "from": "nginx:1.0", "to": "nginx:2.0" },
          "ports": { "added": ["443:443"] },
          "environment": { "added": ["NEW_VAR"], "changed": ["DB_PASSWORD"] }
        }
      }
    },
    "secretsChanged": ["DB_PASSWORD"]
  }
}
```

Compared with a text diff this survives duplicate lines (`restart: always` in three services) and key reordering, and every change arrives attributed to its service. Ordered arrays such as `command`, `entrypoint`, `healthcheck.test`, and `env_file` are compared positionally. `$VAR` and `$$VAR` are different: Docker interpolates the former and treats the latter as a literal dollar sign. Previews retain that distinction and do not evaluate variables from the remote Docker environment.

Env var **values only appear when the redaction mode would have shown them anyway**: never in `all`, only for non-sensitive names in `sensitive`, and freely in `none`. A changed value you can't see is still reported by name, both in `environment.changed` and in the document-wide `secretsChanged` list, so you always know *that* a secret moved without it being printed into the conversation.

### Compose history

If your Swarmpit serves `/api/stacks/{name}/history`, `get_stack_history` lists past revisions of a stack — newest first, **metadata only** by default, since an uncapped history of full composes is exactly the payload problem to avoid:

```jsonc
{ "entries": [
  { "index": 0, "at": "...", "by": "claude", "comment": "bump nginx for CVE-2026-1234", "trigger": {"kind": "stack-update"} },
  { "index": 1, "at": "...", "by": "admin",  "comment": "initial rollout", "trigger": {"kind": "stack-create"} } ] }
```

Pass `index` for one revision's compose (sanitized like every other compose path), or `index` + `diff: true` to get the semantic diff between that revision and the live stack.

Every stack write — `create_stack`, `update_stack`, `redeploy_stack`, `rollback_stack` — takes an optional `comment`: a one-line title for the change, written like a commit subject. It is recorded in the history and shown in Swarmpit's UI, which has no field for it, so an agent making the change is the one best placed to explain it. Older Swarmpit versions ignore the parameter.

### Large payloads

Two tool families return far more than fits comfortably in context, so both reduce server-side:

- **Timeseries** (`get_nodes_timeseries`, `get_services_*_timeseries`, `get_task_timeseries`) accept `points` (bucket count, default 12), `agg` (`avg`/`max`/`min`), `match` (filter series by name) and `stats_only`. Summary statistics are computed from the *full* series before downsampling, so `stats.max` is the real peak, not the peak of an average. A 30-service / 720-sample payload comes back over 10× smaller by default.
- **`service_logs`** accepts `grep` (substring, or `/regex/flags`) and `tail`, applied before the result is returned. The reply reports `total`, `returned` and what was `dropped`, so a filtered view never looks like the whole log.

Regex matching starts fresh for each log entry, including when `g` or `y` is supplied.

## Development

The SDK's HTTP adapter is constrained to its patched Node 18-compatible 1.19.x line so dependency resolution does not pull in the Node 20-only 2.x line. This server still uses stdio, not HTTP.

```bash
git clone https://github.com/swarmpit/mcp
cd mcp
npm install
npm run build        # compile TypeScript
npm run dev          # watch mode
npm test             # run tests
```

When developing locally, point `.mcp.json` at your local build:

```json
{
  "mcpServers": {
    "swarmpit-dev": {
      "command": "node",
      "args": ["/path/to/mcp/dist/index.js"],
      "env": {
        "SWARMPIT_URL": "https://swarmpit.example.com",
        "SWARMPIT_TOKEN": "your-token",
        "SWARMPIT_REDACT": "sensitive"
      }
    }
  }
}
```

## License

MIT
