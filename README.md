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

### Multiple servers

Register each as a separate MCP server instance:

```json
{
  "mcpServers": {
    "swarmpit-prod": {
      "command": "npx",
      "args": ["github:swarmpit/mcp"],
      "env": {
        "SWARMPIT_URL": "https://swarmpit.prod.example.com",
        "SWARMPIT_TOKEN": "prod-token",
        "SWARMPIT_REDACT": "sensitive"
      }
    },
    "swarmpit-staging": {
      "command": "npx",
      "args": ["github:swarmpit/mcp"],
      "env": {
        "SWARMPIT_URL": "https://swarmpit.staging.example.com",
        "SWARMPIT_TOKEN": "staging-token",
        "SWARMPIT_REDACT": "sensitive"
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
| `SWARMPIT_REDACT_PATTERNS` | No | Comma-separated extra patterns to redact in `sensitive` mode (regex, case-insensitive) |

### Redaction modes

| Mode | Env vars | Secrets/Configs data |
|------|----------|---------------------|
| `all` | All values redacted | Redacted |
| `sensitive` | Only names matching patterns | Redacted |
| `none` | No redaction | Not redacted |

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
| `create_secret` | Create a secret (supports `$env` references) |
| `delete_secret` | Delete (requires `confirm: true`) |
| `get_secret_services` | List services using a secret |

### Configs

| Tool | Description |
|------|-------------|
| `list_configs` | List all configs (data redacted) |
| `get_config` | Get config details (data redacted) |
| `create_config` | Create a config |
| `delete_config` | Delete (requires `confirm: true`) |
| `get_config_services` | List services using a config |

### Admin

| Tool | Description |
|------|-------------|
| `list_users` | List all Swarmpit users |
| `get_user` | Get user details |
| `create_user` | Create a user |
| `edit_user` | Edit user properties |
| `delete_user` | Delete (requires `confirm: true`) |

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
