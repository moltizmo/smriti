import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type Database from "better-sqlite3";
import type { EmbeddingEngine } from "./embedding/engine.js";
import type { MetadataExtractor } from "./extraction/metadata.js";
import {
  insertThought,
  getThought,
  deleteThought,
  getRecentThoughts,
  getStats,
} from "./db/store.js";
import { vectorSearch } from "./db/search.js";

export function createServer(
  db: Database.Database,
  embedder: EmbeddingEngine,
  extractor: MetadataExtractor
): McpServer {
  const server = new McpServer(
    { name: "smriti", version: "0.1.0" },
    {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
      },
      instructions:
        "Smriti is your persistent memory. Use 'capture' to store thoughts, 'search' to find them semantically, 'recall' to browse recent memories, 'forget' to delete, 'context' for deep topic background, and 'stats' for memory patterns.",
    }
  );

  // ── Tools ──────────────────────────────────────────────

  server.tool(
    "capture",
    "Store a thought. Auto-generates embedding and extracts metadata (people, topics, actions, type).",
    {
      text: z.string().describe("The thought or note to capture"),
      type: z
        .enum([
          "insight",
          "decision",
          "person_note",
          "meeting",
          "idea",
          "reference",
          "general",
        ])
        .optional()
        .describe("Type of thought (auto-classified if omitted)"),
      source: z
        .string()
        .optional()
        .describe("Which client sent this (e.g. claude-code, cursor)"),
    },
    async (args) => {
      const metadata = extractor.extract(args.text);
      if (args.type) metadata.type = args.type;

      const embedding = await embedder.embed(args.text);
      const thought = insertThought(db, args.text, embedding, {
        ...metadata,
        source: args.source,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                status: "captured",
                id: thought.id,
                type: thought.type,
                people: thought.people,
                topics: thought.topics,
                actions: thought.actions,
                sentiment: thought.sentiment,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.tool(
    "search",
    "Semantic search — find thoughts by meaning, not just keywords.",
    {
      query: z.string().describe("Search query (semantic)"),
      limit: z.number().optional().default(5).describe("Max results (default 5)"),
      after: z
        .string()
        .optional()
        .describe("Only thoughts after this date (ISO format)"),
      type: z
        .string()
        .optional()
        .describe("Filter by thought type"),
    },
    async (args) => {
      const queryEmbedding = await embedder.embed(args.query);
      const results = vectorSearch(db, queryEmbedding, {
        limit: args.limit,
        after: args.after,
        type: args.type,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              results.map((r) => ({
                id: r.thought.id,
                text: r.thought.text,
                type: r.thought.type,
                score: Math.round(r.score * 100) / 100,
                people: r.thought.people,
                topics: r.thought.topics,
                created_at: r.thought.created_at,
              })),
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.tool(
    "recall",
    "Browse recent memories with filters.",
    {
      days: z.number().optional().default(7).describe("Look back N days (default 7)"),
      type: z.string().optional().describe("Filter by thought type"),
      topic: z.string().optional().describe("Filter by topic"),
      person: z.string().optional().describe("Filter by person mentioned"),
      limit: z.number().optional().default(20).describe("Max results"),
    },
    async (args) => {
      const thoughts = getRecentThoughts(db, {
        days: args.days,
        type: args.type,
        topic: args.topic,
        person: args.person,
        limit: args.limit,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              thoughts.map((t) => ({
                id: t.id,
                text: t.text,
                type: t.type,
                people: t.people,
                topics: t.topics,
                created_at: t.created_at,
              })),
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.tool(
    "forget",
    "Delete a specific memory by ID.",
    {
      id: z.string().describe("Thought ID to delete"),
      confirm: z
        .boolean()
        .describe("Must be true to confirm deletion"),
    },
    async (args) => {
      if (!args.confirm) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Deletion not confirmed. Set confirm: true to delete.",
            },
          ],
        };
      }

      const thought = getThought(db, args.id);
      if (!thought) {
        return {
          content: [
            { type: "text" as const, text: `No thought found with id: ${args.id}` },
          ],
        };
      }

      deleteThought(db, args.id);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              status: "deleted",
              id: args.id,
              text_preview: thought.text.slice(0, 100),
            }),
          },
        ],
      };
    }
  );

  server.tool(
    "context",
    "Get a structured context bundle for a topic — all related thoughts, people, decisions, and timeline.",
    {
      topic: z.string().describe("Topic to get context for"),
      depth: z
        .enum(["summary", "full"])
        .optional()
        .default("summary")
        .describe("Level of detail"),
    },
    async (args) => {
      const queryEmbedding = await embedder.embed(args.topic);
      const limit = args.depth === "full" ? 30 : 10;
      const results = vectorSearch(db, queryEmbedding, { limit });

      const people = new Set<string>();
      const topics = new Set<string>();
      const decisions: string[] = [];
      const actions: string[] = [];

      for (const r of results) {
        r.thought.people.forEach((p) => people.add(p));
        r.thought.topics.forEach((t) => topics.add(t));
        if (r.thought.type === "decision") decisions.push(r.thought.text);
        r.thought.actions.forEach((a) => actions.push(a));
      }

      const bundle = {
        topic: args.topic,
        thought_count: results.length,
        people: [...people],
        related_topics: [...topics],
        decisions,
        open_actions: actions,
        timeline: results.map((r) => ({
          date: r.thought.created_at,
          type: r.thought.type,
          text:
            args.depth === "full"
              ? r.thought.text
              : r.thought.text.slice(0, 150),
          score: Math.round(r.score * 100) / 100,
        })),
      };

      return {
        content: [
          { type: "text" as const, text: JSON.stringify(bundle, null, 2) },
        ],
      };
    }
  );

  server.tool(
    "stats",
    "Memory patterns and insights — thought count, top topics, top people, type distribution.",
    {
      period: z
        .enum(["week", "month", "all"])
        .optional()
        .default("month")
        .describe("Time period"),
    },
    async (args) => {
      const stats = getStats(db, args.period);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(stats, null, 2) },
        ],
      };
    }
  );

  // ── Resources ──────────────────────────────────────────

  server.resource(
    "recent-thoughts",
    "memory://recent",
    { description: "Last 24 hours of thoughts", mimeType: "application/json" },
    async () => {
      const thoughts = getRecentThoughts(db, { days: 1 });
      return {
        contents: [
          {
            uri: "memory://recent",
            mimeType: "application/json",
            text: JSON.stringify(thoughts, null, 2),
          },
        ],
      };
    }
  );

  server.resource(
    "topic-index",
    "memory://topics",
    {
      description: "Topic index with counts",
      mimeType: "application/json",
    },
    async () => {
      const stats = getStats(db, "all");
      return {
        contents: [
          {
            uri: "memory://topics",
            mimeType: "application/json",
            text: JSON.stringify(stats.top_topics, null, 2),
          },
        ],
      };
    }
  );

  server.resource(
    "people-index",
    "memory://people",
    {
      description: "People mentioned with context",
      mimeType: "application/json",
    },
    async () => {
      const stats = getStats(db, "all");
      return {
        contents: [
          {
            uri: "memory://people",
            mimeType: "application/json",
            text: JSON.stringify(stats.top_people, null, 2),
          },
        ],
      };
    }
  );

  server.resource(
    "memory-stats",
    "memory://stats",
    {
      description: "Overall memory statistics",
      mimeType: "application/json",
    },
    async () => {
      const stats = getStats(db, "all");
      return {
        contents: [
          {
            uri: "memory://stats",
            mimeType: "application/json",
            text: JSON.stringify(stats, null, 2),
          },
        ],
      };
    }
  );

  // ── Prompts ────────────────────────────────────────────

  server.prompt(
    "brain-dump",
    "Guided capture session — interview-style prompts to extract and store thoughts",
    {},
    async () => {
      const recent = getRecentThoughts(db, { days: 1, limit: 5 });
      const recentSummary =
        recent.length > 0
          ? recent.map((t) => `- [${t.type}] ${t.text.slice(0, 80)}`).join("\n")
          : "No recent thoughts captured today.";

      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: `You are helping me capture thoughts into my persistent memory (Smriti).

Here's what I've already captured today:
${recentSummary}

Please interview me to extract thoughts worth remembering. Ask me:
1. What's on my mind right now?
2. Any decisions I've made or need to make?
3. People I've talked to and what came up?
4. Ideas or insights I don't want to forget?
5. Action items or TODOs?

For each thing I share, use the 'capture' tool to store it. Classify each thought appropriately.`,
            },
          },
        ],
      };
    }
  );

  server.prompt(
    "weekly-review",
    "End-of-week synthesis across all captured thoughts",
    {},
    async () => {
      const thoughts = getRecentThoughts(db, { days: 7 });
      const stats = getStats(db, "week");

      const thoughtList = thoughts
        .map(
          (t) =>
            `[${t.created_at}] (${t.type}) ${t.text}${t.people.length > 0 ? ` [people: ${t.people.join(", ")}]` : ""}${t.actions.length > 0 ? ` [actions: ${t.actions.join("; ")}]` : ""}`
        )
        .join("\n");

      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: `Please synthesize my week based on these captured thoughts.

Stats: ${stats.period_count} thoughts, top topics: ${stats.top_topics.map(([t, c]) => `${t}(${c})`).join(", ")}, top people: ${stats.top_people.map(([p, c]) => `${p}(${c})`).join(", ")}

All thoughts this week:
${thoughtList}

Please provide:
1. **Key themes** — What dominated my thinking this week?
2. **Decisions made** — What did I decide, and are there any I should revisit?
3. **People** — Who did I interact with and what were the key discussions?
4. **Open actions** — What TODOs are still pending?
5. **Insights** — Any patterns or things I should pay attention to?
6. **Suggested captures** — Anything from this synthesis worth capturing as a new thought?`,
            },
          },
        ],
      };
    }
  );

  server.prompt(
    "migrate",
    "Import memories from another source — paste text to extract and store individual thoughts",
    {
      source: z
        .string()
        .optional()
        .describe("Source name (e.g. 'claude', 'chatgpt', 'notes')"),
    },
    async (args) => {
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: `I want to migrate memories into Smriti from ${args.source ?? "another source"}.

I'll paste text containing things I want to remember. For each distinct thought, fact, or piece of context:
1. Identify it as a separate thought
2. Use the 'capture' tool to store it with source: "${args.source ?? "migration"}"
3. Let me know what you extracted and stored

Ready — I'll paste my content now.`,
            },
          },
        ],
      };
    }
  );

  return server;
}
