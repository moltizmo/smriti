#!/usr/bin/env node

import { execSync } from "node:child_process";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, ensureSmritiDir } from "./config.js";
import { initDatabase } from "./db/schema.js";
import { OnnxEmbeddingEngine } from "./embedding/onnx.js";
import { RulesExtractor } from "./extraction/rules.js";
import { createServer } from "./server.js";
import { consolidateMemories } from "./consolidation/index.js";
import { exportToMarkdown } from "./sync/export.js";
import { importFromMarkdown } from "./sync/import.js";
import { syncToGit } from "./sync/git.js";
import { getStats, getRecentThoughts } from "./db/store.js";
import { vectorSearch } from "./db/search.js";
import { extractMemories } from "./extraction/ingest.js";
import {
  saveGitHubToken,
  clearCredentials,
  getAuthStatus,
} from "./auth/credentials.js";
import {
  getAuthenticatedUser,
  ensureSyncRepo,
  requestDeviceCode,
  pollForToken,
  hasClientId,
} from "./auth/github.js";

const args = process.argv.slice(2);
const command = args[0];

async function runCLI() {
  if (command === "--version" || command === "-v") {
    console.log("smriti v0.3.2");
    process.exit(0);
  }

  if (command === "--help" || command === "-h") {
    console.log(`smriti v0.3.2 — Local-first persistent memory for AI agents

Usage: smriti <command> [options]

Commands:
  capture <text>          Save a thought or note
  recall [query]          Browse recent memories
  search <query>          Semantic search across all memories
  ingest --text <text>    Batch-extract memories from long text
  stats                   Memory statistics
  consolidate             Merge similar memories
  export                  Export memories to Markdown files
  import                  Import memories from Markdown files
  sync                    Sync memories to GitHub
  auth                    Connect your GitHub account
  logout                  Disconnect GitHub account
  whoami                  Show current auth status

Options:
  --version, -v           Show version
  --help, -h              Show this help

MCP Server: run with no arguments to start as an MCP server (stdio mode).
`);
    process.exit(0);
  }

  ensureSmritiDir();
  const config = loadConfig();
  const db = initDatabase(config.db_path);
  const embedder = new OnnxEmbeddingEngine();

  switch (command) {
    case "consolidate": {
      const dryRun = args.includes("--dry-run");
      const daysIdx = args.indexOf("--days");
      const days = daysIdx !== -1 ? parseInt(args[daysIdx + 1] ?? "7", 10) : 7;
      console.log(`🧠 Consolidating memories (${dryRun ? "dry run" : "live"}, last ${days} days)...`);
      const result = await consolidateMemories(db, embedder, { dry_run: dryRun, days });
      console.log(`✅ Merged: ${result.merged} | Promoted: ${result.promoted} | Archived: ${result.archived}`);
      if (result.groups.length > 0) {
        console.log("\nGroups consolidated:");
        result.groups.forEach((g, i) => {
          console.log(`  ${i + 1}. [${g.source_ids.length} thoughts] ${g.summary.slice(0, 80)}...`);
        });
      }
      break;
    }

    case "export": {
      const dirIdx = args.indexOf("--dir");
      const exportDir = dirIdx !== -1 ? args[dirIdx + 1] : config.sync.export_dir;
      const sinceIdx = args.indexOf("--since");
      const since = sinceIdx !== -1 ? args[sinceIdx + 1] : undefined;
      console.log(`📤 Exporting memories to ${exportDir}...`);
      const result = exportToMarkdown(db, exportDir!, { since });
      console.log(`✅ Exported ${result.thoughts_exported} thoughts to ${result.files_written.length} files`);
      break;
    }

    case "import": {
      const dirIdx = args.indexOf("--dir");
      const importDir = dirIdx !== -1 ? args[dirIdx + 1] : config.sync.export_dir;
      console.log(`📥 Importing memories from ${importDir}...`);
      const result = await importFromMarkdown(db, embedder, importDir!);
      console.log(`✅ Imported: ${result.imported} | Skipped (dupes): ${result.skipped} | Errors: ${result.errors}`);
      break;
    }

    case "sync": {
      const repoIdx = args.indexOf("--repo");
      const repoPath = repoIdx !== -1 ? args[repoIdx + 1] : config.sync.repo_path;
      console.log(`🔄 Syncing memories...`);
      const result = syncToGit(db, config.sync.export_dir, repoPath ?? null);
      console.log(result.message);
      break;
    }

    case "stats": {
      const stats = getStats(db, "month");
      console.log(`📊 Smriti Stats`);
      console.log(`  Total thoughts: ${stats.total}`);
      console.log(`  This month: ${stats.period_count}`);
      console.log(`  Top topics: ${stats.top_topics.slice(0, 5).map(([t, c]) => `${t}(${c})`).join(", ")}`);
      console.log(`  Top people: ${stats.top_people.slice(0, 5).map(([p, c]) => `${p}(${c})`).join(", ")}`);
      break;
    }

    case "capture": {
      // Quick CLI capture: npx smriti capture --text "..." [--tags "tag1,tag2"]
      const textIdx = args.indexOf("--text");
      const text = textIdx !== -1 ? args[textIdx + 1] : args.slice(1).join(" ");
      if (!text) { console.error("Usage: smriti capture --text 'your thought'"); process.exit(1); }
      const extractor = new RulesExtractor();
      const metadata = extractor.extract(text);
      const embedding = await embedder.embed(text);
      const { insertThought } = await import("./db/store.js");
      const thought = insertThought(db, text, embedding, { ...metadata, source: "cli" });
      console.log(`✅ Captured: ${thought.id} [${thought.type}]`);
      break;
    }

    case "auth": {
      if (!hasClientId()) {
        console.error(
          "❌ Smriti OAuth App not configured.\n\n" +
          "To set up your own OAuth App:\n" +
          "  1. Go to https://github.com/settings/developers → 'New OAuth App'\n" +
          "  2. Enable 'Device Flow' on the app\n" +
          "  3. Set SMRITI_CLIENT_ID=<your_client_id> before running smriti auth\n\n" +
          "If using the official Smriti CLI from npm, this is pre-configured.\n" +
          "SMRITI_CLIENT_ID env var overrides the default."
        );
        process.exit(1);
      }

      console.log("🔑 Connecting to GitHub...");
      const deviceCode = await requestDeviceCode();

      // Try to open browser automatically
      const openCmd = process.platform === "darwin" ? "open" :
                      process.platform === "win32" ? "start" : "xdg-open";
      try {
        execSync(`${openCmd} "${deviceCode.verification_uri}"`, { stdio: "ignore" });
      } catch { /* browser open failed — user will do it manually */ }

      console.log(`\n! First copy your one-time code: ${deviceCode.user_code}`);
      console.log(`- Then press Enter to open ${deviceCode.verification_uri} in your browser...`);

      // Wait for Enter keypress
      await new Promise<void>(resolve => {
        process.stdin.setRawMode?.(true);
        process.stdin.resume();
        process.stdin.once("data", () => {
          process.stdin.setRawMode?.(false);
          process.stdin.pause();
          resolve();
        });
      });

      console.log("⏳ Waiting for GitHub authorization...");
      const token = await pollForToken(deviceCode.device_code, deviceCode.interval);

      const user = await getAuthenticatedUser(token);
      console.log(`✅ Authenticated as: ${user.login}${user.name ? ` (${user.name})` : ""}`);

      console.log("📦 Setting up sync repo...");
      const repo = await ensureSyncRepo(token, user.login);
      saveGitHubToken(token, user.login, repo.full_name);

      console.log(`✅ Logged in. Sync repo: ${repo.html_url}`);
      console.log(`\nRun 'smriti sync' to push your memories.`);
      break;
    }

    case "logout": {
      clearCredentials();
      console.log("✅ Credentials cleared.");
      break;
    }

    case "whoami": {
      const status = getAuthStatus();
      if (!status.authenticated) {
        console.log("Not authenticated. Run: smriti auth");
      } else {
        console.log(`Logged in as: ${status.username}`);
        console.log(`Sync repo:    github.com/${status.sync_repo}`);
      }
      break;
    }

    case "recall": {
      // npx smriti recall [query] [--days N] [--type TYPE] [--limit N]
      const daysIdx = args.indexOf("--days");
      const days = daysIdx !== -1 ? parseInt(args[daysIdx + 1] ?? "7", 10) : 7;
      const typeIdx = args.indexOf("--type");
      const type = typeIdx !== -1 ? args[typeIdx + 1] : undefined;
      const limitIdx = args.indexOf("--limit");
      const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1] ?? "20", 10) : 20;
      // Collect positional args (not flags, not their values)
      const flagValueIdxs = new Set([daysIdx + 1, typeIdx + 1, limitIdx + 1].filter(i => i > 0));
      const topic = args.slice(1).filter((a, i) => !a.startsWith("--") && !flagValueIdxs.has(i + 1)).join(" ").trim() || undefined;
      const thoughts = getRecentThoughts(db, { days, type, topic, limit });
      if (thoughts.length === 0) {
        console.log(`📭 No memories found in the last ${days} days.`);
      } else {
        console.log(`🧠 ${thoughts.length} memor${thoughts.length !== 1 ? "ies" : "y"} (last ${days} days):\n`);
        thoughts.forEach(t => {
          const when = new Date(t.created_at).toLocaleDateString();
          const meta = [t.type, ...t.people.slice(0, 2), ...t.topics.slice(0, 2)].filter(Boolean).join(", ");
          console.log(`• [${when}] ${t.text}`);
          if (meta) console.log(`  ↳ ${meta}`);
        });
      }
      break;
    }

    case "search": {
      // npx smriti search "query" [--limit N] [--type TYPE]
      const query = args.filter(a => !a.startsWith("--") && a !== "search").join(" ").trim();
      if (!query) { console.error("Usage: smriti search \"your query\""); process.exit(1); }
      const limitIdx = args.indexOf("--limit");
      const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1] ?? "5", 10) : 5;
      const typeIdx = args.indexOf("--type");
      const type = typeIdx !== -1 ? args[typeIdx + 1] : undefined;
      console.log(`🔍 Searching: "${query}"...\n`);
      const queryEmbedding = await embedder.embed(query);
      const results = vectorSearch(db, queryEmbedding, { limit, type });
      if (results.length === 0) {
        console.log("📭 No matching memories found.");
      } else {
        results.forEach((r, i) => {
          const when = new Date(r.thought.created_at).toLocaleDateString();
          const score = Math.round(r.score * 100);
          console.log(`${i + 1}. [${score}% match • ${when}] ${r.thought.text}`);
          const meta = [...r.thought.people.slice(0, 2), ...r.thought.topics.slice(0, 2)].filter(Boolean).join(", ");
          if (meta) console.log(`   ↳ ${meta}`);
        });
      }
      break;
    }

    case "ingest": {
      // npx smriti ingest --text "long conversation..." [--threshold 0.5]
      const textIdx = args.indexOf("--text");
      const text = textIdx !== -1 ? args[textIdx + 1] : args.slice(1).join(" ");
      if (!text) { console.error("Usage: smriti ingest --text 'conversation or document text'"); process.exit(1); }
      const threshIdx = args.indexOf("--threshold");
      const threshold = threshIdx !== -1 ? parseFloat(args[threshIdx + 1] ?? "0.5") : 0.5;
      console.log(`🧠 Ingesting text (threshold: ${threshold})...`);
      const { insertThought: insertT } = await import("./db/store.js");
      const items = extractMemories(text, threshold);
      if (items.length === 0) {
        console.log("📭 No memorable content detected. Try lowering --threshold.");
        break;
      }
      const extractor2 = new RulesExtractor();
      let captured = 0;
      for (const item of items) {
        const metadata = extractor2.extract(item.text);
        metadata.type = item.type;
        const embedding = await embedder.embed(item.text);
        const thought = insertT(db, item.text, embedding, { ...metadata, source: "cli-ingest" });
        console.log(`  • [${thought.type}] ${item.text.slice(0, 80)}${item.text.length > 80 ? "..." : ""}`);
        captured++;
      }
      console.log(`\n✅ Captured ${captured} memories.`);
      break;
    }

    default:
      await runServer(config, db, embedder);
  }
}

async function runServer(
  config: Awaited<ReturnType<typeof loadConfig>>,
  db: import("better-sqlite3").Database,
  embedder: OnnxEmbeddingEngine
) {
  const useHttp = args.includes("--http");
  const portIdx = args.indexOf("--port");
  const port = portIdx !== -1 && args[portIdx + 1] ? parseInt(args[portIdx + 1], 10) : undefined;

  if (useHttp) config.server.transport = "http";
  if (port) config.server.port = port;

  const extractor = new RulesExtractor();
  const server = createServer(db, embedder, extractor);

  // Auto-sync on startup if configured
  if (config.sync.auto_sync_hours != null) {
    const lastExportFile = `${config.sync.export_dir}/index.md`;
    let shouldSync = true;
    try {
      const { statSync } = await import("node:fs");
      const stat = statSync(lastExportFile);
      const hoursSince = (Date.now() - stat.mtimeMs) / 3_600_000;
      shouldSync = hoursSince >= config.sync.auto_sync_hours;
    } catch { /* first run */ }

    if (shouldSync) {
      try {
        syncToGit(db, config.sync.export_dir, config.sync.repo_path);
        console.error("Smriti: auto-sync completed");
      } catch (e) {
        console.error("Smriti: auto-sync failed:", e);
      }
    }
  }

  if (config.server.transport === "http") {
    const { createServer: createHttpServer } = await import("node:http");
    const { StreamableHTTPServerTransport } = await import(
      "@modelcontextprotocol/sdk/server/streamableHttp.js"
    );
    const { randomUUID } = await import("node:crypto");

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });

    await server.connect(transport);

    const httpServer = createHttpServer(async (req, res) => {
      // Health check endpoint
      if (req.url === "/health" && req.method === "GET") {
        const stats = getStats(db, "all");
        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ status: "ok", thoughts: stats.total, version: "0.2.0" }));
        return;
      }
      if (req.url === "/mcp" && req.method === "POST") {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
        }
        const body = JSON.parse(Buffer.concat(chunks).toString());
        await transport.handleRequest(req, res, body);
      } else {
        res.writeHead(404);
        res.end("Not found");
      }
    });

    httpServer.listen(config.server.port, () => {
      console.error(`Smriti MCP server v0.3.2 (HTTP) listening on port ${config.server.port}`);
      console.error(`Health: http://localhost:${config.server.port}/health`);
    });
  } else {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Smriti MCP server v0.3.2 started (stdio)");
  }
}

runCLI().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
