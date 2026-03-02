# Smriti — Architecture

**Local-first persistent memory for AI agents via MCP.**

*Smriti (स्मृति) — Sanskrit for "memory, remembrance"*

One brain. Every agent. Zero cloud. Zero cost.

## Problem

Every AI tool (Claude, ChatGPT, Cursor, Kiro, Codex) maintains its own siloed memory. None of them talk to each other. When you switch tools, you start from zero. Autonomous agents can't access your accumulated context.

## Solution

A standalone MCP server backed by **sqlite-vec** and a local embedding model. Install it, point any MCP-compatible agent at it, and every AI you use shares one persistent, semantically searchable memory.

## Why This Over Postgres/Supabase?

| | Smriti | Supabase + PG Vector |
|---|---|---|
| **Setup** | `npx smriti` | Supabase account + edge functions + config |
| **Cost** | $0 | ~$0.10-0.30/mo (free tier limits) |
| **Dependencies** | None (sqlite bundled) | Postgres, Supabase, cloud account |
| **Privacy** | 100% local | Data on Supabase servers |
| **Portability** | Single `.db` file | DB export/migration |
| **Offline** | Full functionality | Needs internet |

## Architecture

```
┌─────────────────────────────────────────────┐
│                 MCP Clients                  │
│  Claude Code │ Cursor │ ChatGPT │ Kiro │ …  │
└──────────────────┬──────────────────────────┘
                   │ MCP Protocol
                   │ (stdio / streamable-http)
┌──────────────────▼──────────────────────────┐
│            Smriti MCP Server            │
│                                              │
│  Tools:                                      │
│  ┌────────────┐ ┌────────────┐ ┌──────────┐ │
│  │  capture    │ │  search    │ │  recall   │ │
│  └────────────┘ └────────────┘ └──────────┘ │
│  ┌────────────┐ ┌────────────┐ ┌──────────┐ │
│  │  forget     │ │  context   │ │  stats    │ │
│  └────────────┘ └────────────┘ └──────────┘ │
│                                              │
│  Resources:                                  │
│  memory://recent  memory://topics            │
│  memory://people  memory://stats             │
│                                              │
│  Prompts:                                    │
│  brain-dump  weekly-review  migrate          │
└──────────────────┬──────────────────────────┘
                   │
┌──────────────────▼──────────────────────────┐
│           Embedding Engine                   │
│  EmbeddingGemma-300M (GGUF, ~600MB)         │
│  or: nomic-embed-text, all-MiniLM-L6-v2     │
│  Runs locally via ONNX / llama.cpp binding   │
└──────────────────┬──────────────────────────┘
                   │
┌──────────────────▼──────────────────────────┐
│           sqlite-vec Database                │
│  Single file: ~/.smriti/brain.db        │
│                                              │
│  Tables:                                     │
│  ┌─────────────────────────────────────────┐ │
│  │ thoughts                                │ │
│  │  id, text, embedding (vec), metadata,   │ │
│  │  type, people[], topics[], actions[],   │ │
│  │  source, created_at, updated_at         │ │
│  └─────────────────────────────────────────┘ │
│  ┌─────────────────────────────────────────┐ │
│  │ thought_vectors (sqlite-vec virtual)    │ │
│  │  rowid → thoughts.id                    │ │
│  │  embedding float32[]                    │ │
│  └─────────────────────────────────────────┘ │
└─────────────────────────────────────────────┘
```

## MCP Tools

### `capture`
Store a thought. Auto-generates embedding + extracts metadata.

```json
{
  "text": "Sarah mentioned she's thinking about leaving her job to start consulting",
  "type": "person_note",       // optional: auto-classified if omitted
  "source": "claude-code"      // optional: which client sent this
}
```

Returns: confirmation with extracted metadata (people, topics, actions).

### `search`
Semantic search — find thoughts by meaning, not keywords.

```json
{
  "query": "career transition plans",
  "limit": 10,                 // default 5
  "after": "2026-02-01",       // optional date filter
  "type": "decision"           // optional type filter
}
```

Returns: scored results with snippets + metadata.

### `recall`
Browse recent memories with filters.

```json
{
  "days": 7,                   // default 7
  "type": "insight",           // optional
  "topic": "architecture",     // optional
  "person": "Sarah"            // optional
}
```

### `forget`
Delete specific memories by ID.

```json
{
  "id": "thought_abc123",
  "confirm": true
}
```

### `context`
Get a structured context bundle for a topic — designed for agents that need deep background.

```json
{
  "topic": "project-alpha",
  "depth": "full"              // "summary" | "full"
}
```

Returns: all related thoughts, people, decisions, and timeline.

### `stats`
Memory patterns and insights.

```json
{
  "period": "month"            // "week" | "month" | "all"
}
```

Returns: thought count, top topics, top people, capture frequency, type distribution.

## MCP Resources

| URI | Description |
|-----|-------------|
| `memory://recent` | Last 24h of thoughts |
| `memory://topics` | Topic index with counts |
| `memory://people` | People mentioned + context |
| `memory://stats` | Overall memory statistics |

## MCP Prompts

| Name | Description |
|------|-------------|
| `brain-dump` | Guided capture session — interview-style prompts to extract thoughts |
| `weekly-review` | End-of-week synthesis across all captured thoughts |
| `migrate` | Pull memories from Claude/ChatGPT and store in Smriti |

## Metadata Extraction

When a thought is captured, a lightweight LLM pass extracts:

- **People**: Names mentioned
- **Topics**: Subject classification
- **Actions**: Any action items or TODOs
- **Type**: `insight` | `decision` | `person_note` | `meeting` | `idea` | `reference` | `general`
- **Sentiment**: `positive` | `neutral` | `negative`

This can be done via:
1. **Local LLM** (llama.cpp, small model) — zero cost, private
2. **API call** (Claude/OpenAI) — better extraction, small cost
3. **Rule-based fallback** — regex patterns, zero deps

Config option lets user choose.

## Tech Stack

- **Language**: TypeScript
- **MCP SDK**: `@modelcontextprotocol/sdk`
- **Database**: `better-sqlite3` + `sqlite-vec`
- **Embeddings**: `@xenova/transformers` (ONNX) or `node-llama-cpp` (GGUF)
- **Transport**: stdio (default) + streamable-http (optional)
- **Package**: npm (`npx smriti`)

## Directory Structure

```
smriti/
├── src/
│   ├── index.ts              # Entry point + MCP server setup
│   ├── server.ts             # MCP tool/resource/prompt handlers
│   ├── db/
│   │   ├── schema.ts         # Database schema + migrations
│   │   ├── store.ts          # CRUD operations
│   │   └── search.ts         # Vector search logic
│   ├── embedding/
│   │   ├── engine.ts         # Embedding interface
│   │   ├── onnx.ts           # ONNX runtime provider
│   │   └── llamacpp.ts       # llama.cpp provider (GGUF)
│   ├── extraction/
│   │   ├── metadata.ts       # Metadata extraction interface
│   │   ├── llm.ts            # LLM-based extraction
│   │   └── rules.ts          # Rule-based fallback
│   └── config.ts             # Configuration management
├── tests/
├── package.json
├── tsconfig.json
├── README.md
├── ARCHITECTURE.md
└── LICENSE                   # MIT
```

## Configuration

`~/.smriti/config.json`:

```json
{
  "db_path": "~/.smriti/brain.db",
  "embedding": {
    "provider": "onnx",
    "model": "nomic-embed-text-v1.5"
  },
  "extraction": {
    "provider": "rules",
    "llm_model": null
  },
  "server": {
    "transport": "stdio",
    "port": 3838
  }
}
```

## Usage

```bash
# Install
npm install -g smriti

# Run (stdio mode — for Claude Code, Cursor, etc.)
smriti

# Run (HTTP mode — for remote agents)
smriti --http --port 3838

# Claude Code config (~/.claude/mcp.json)
{
  "mcpServers": {
    "memory": {
      "command": "smriti"
    }
  }
}

# Cursor config
{
  "mcpServers": {
    "memory": {
      "command": "npx",
      "args": ["smriti"]
    }
  }
}
```

## What Makes This Different

1. **Zero cloud** — everything local, single file DB
2. **Zero cost** — no API keys needed for base functionality
3. **Universal** — works with any MCP client, current and future
4. **Portable** — copy one `.db` file to move your brain
5. **Private** — your thoughts never leave your machine
6. **Composable** — agents can both read and write, building shared context
