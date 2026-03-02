# Smriti

**Local-first persistent memory for AI agents via MCP.**

*Smriti (स्मृति) — Sanskrit for "memory, remembrance"*

One brain. Every agent. Zero cloud. Zero cost.

## What is this?

A standalone MCP server backed by **sqlite-vec** and a local embedding model. Install it, point any MCP-compatible agent at it, and every AI you use shares one persistent, semantically searchable memory.

| | Smriti | Cloud alternatives |
|---|---|---|
| **Setup** | `npx smriti` | Accounts + API keys + config |
| **Cost** | $0 | Variable |
| **Privacy** | 100% local | Data on external servers |
| **Offline** | Full functionality | Needs internet |
| **Portability** | Single `.db` file | DB export/migration |

## Install

```bash
npm install -g smriti
```

## Usage

```bash
# stdio mode (for Claude Code, Cursor, etc.)
smriti

# HTTP mode (for remote agents)
smriti --http --port 3838
```

## MCP Client Configuration

### Claude Code

Add to `~/.claude/mcp.json`:

```json
{
  "mcpServers": {
    "memory": {
      "command": "smriti"
    }
  }
}
```

### Cursor

Add to MCP settings:

```json
{
  "mcpServers": {
    "memory": {
      "command": "npx",
      "args": ["smriti"]
    }
  }
}
```

### Any MCP client (HTTP mode)

```bash
smriti --http --port 3838
```

Then point your client at `http://localhost:3838/mcp`.

## Tools

| Tool | Description |
|------|-------------|
| `capture` | Store a thought with auto-extracted metadata |
| `search` | Semantic search — find thoughts by meaning |
| `recall` | Browse recent memories with filters |
| `forget` | Delete a specific memory by ID |
| `context` | Get structured context bundle for a topic |
| `stats` | Memory patterns and insights |

## Resources

| URI | Description |
|-----|-------------|
| `memory://recent` | Last 24h of thoughts |
| `memory://topics` | Topic index with counts |
| `memory://people` | People mentioned + context |
| `memory://stats` | Overall memory statistics |

## Prompts

| Name | Description |
|------|-------------|
| `brain-dump` | Guided capture session |
| `weekly-review` | End-of-week synthesis |
| `migrate` | Import memories from other sources |

## Configuration

Config lives at `~/.smriti/config.json`:

```json
{
  "db_path": "~/.smriti/brain.db",
  "embedding": {
    "provider": "onnx",
    "model": "Xenova/all-MiniLM-L6-v2"
  },
  "extraction": {
    "provider": "rules"
  },
  "server": {
    "transport": "stdio",
    "port": 3838
  }
}
```

## How it works

1. You (or an agent) call `capture` with text
2. Smriti generates a vector embedding locally (all-MiniLM-L6-v2 via ONNX)
3. Regex-based extraction pulls out people, topics, actions, and classifies the type
4. Everything is stored in a single SQLite file with sqlite-vec for vector search
5. `search` finds thoughts by semantic similarity, not just keywords
6. All data stays on your machine — nothing leaves localhost

## License

MIT
