# mcp-swarmpit

MCP server for managing [Swarmpit](https://swarmpit.io) Docker Swarm instances from [Claude Code](https://claude.ai/code) and other MCP clients.

The server runs locally and holds API tokens — they never enter the LLM conversation context.

## Setup

```bash
git clone https://github.com/swarmpit/mcp
cd mcp
npm install
npm run build
```

## Configuration

Add to your `.mcp.json` (project-level) or `~/.claude.json` (global):

```json
{
  "mcpServers": {
    "swarmpit-prod": {
      "command": "node",
      "args": ["/path/to/mcp-swarmpit/dist/index.js"],
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

### Multiple servers

Register each as a separate MCP server instance:

```json
{
  "mcpServers": {
    "swarmpit-prod": {
      "command": "node",
      "args": ["/path/to/mcp-swarmpit/dist/index.js"],
      "env": {
        "SWARMPIT_URL": "https://swarmpit.prod.example.com",
        "SWARMPIT_TOKEN": "prod-token",
        "SWARMPIT_REDACT": "sensitive"
      }
    },
    "swarmpit-staging": {
      "command": "node",
      "args": ["/path/to/mcp-swarmpit/dist/index.js"],
      "env": {
        "SWARMPIT_URL": "https://swarmpit.staging.example.com",
        "SWARMPIT_TOKEN": "staging-token",
        "SWARMPIT_REDACT": "none"
      }
    }
  }
}
```

Tools appear namespaced: `swarmpit-prod: list_services`, `swarmpit-staging: list_services`.

### Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SWARMPIT_URL` | Yes | Swarmpit instance URL |
| `SWARMPIT_TOKEN` | Yes | API token (with or without `Bearer ` prefix) |
| `SWARMPIT_REDACT` | No | Redaction mode: `all` (default), `sensitive`, or `none` |

### Redaction modes

| Mode | Env vars | Commands |
|------|----------|----------|
| `all` | All values redacted | Not redacted |
| `sensitive` | Only names matching patterns (`pass`, `secret`, `token`, `key`, `auth`, `credential`, `private`, `dsn`, `connection_string`) | Not redacted |
| `none` | No redaction | Not redacted |

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
| `scale_service` | Scale replicas |
| `list_service_tasks` | List service tasks/containers |
| `delete_service` | Delete (requires `confirm: true`) |
| `update_service_env` | Set/remove env vars |
| `get_service_env` | Get specific env var values |

### Stacks

| Tool | Description |
|------|-------------|
| `list_stacks` | List all stacks |
| `get_stack` | Get stack services and compose file |
| `create_stack` | Create from compose YAML |
| `update_stack` | Update with new compose YAML |
| `redeploy_stack` | Redeploy all services |
| `delete_stack` | Delete (requires `confirm: true`) |

### Infrastructure

| Tool | Description |
|------|-------------|
| `list_networks` / `get_network` | Docker networks |
| `list_nodes` / `get_node` | Swarm nodes |
| `list_tasks` | All tasks across services |
| `list_volumes` / `get_volume` | Docker volumes |
| `swarmpit_info` | Show connected URL and redaction mode |

## Secret handling

Secrets in `.mcp.json` `env` are passed to the MCP server process but **never sent to the LLM**.

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
  DB_PASSWORD: [REDACTED]        # redacted

# Sent to update_stack — only NODE_ENV changed:
environment:
  NODE_ENV: staging              # new value
  DB_PASSWORD: [REDACTED]        # preserved from current stack
```

Use `$env:VAR_NAME` for new secrets in compose:

```yaml
environment:
  NEW_SECRET: $env:MY_SECRET     # resolved locally
```

## Development

```bash
npm install
npm run build        # compile TypeScript
npm run dev          # watch mode
npm test             # run tests
```

## License

MIT
