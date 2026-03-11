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
import { getStats } from "./db/store.js";
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
        console.log("Not authenticated. Run: smriti auth --token <github_pat>");
      } else {
        console.log(`Logged in as: ${status.username}`);
        console.log(`Sync repo:    github.com/${status.sync_repo}`);
      }
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
      console.error(`Smriti MCP server v0.2.0 (HTTP) listening on port ${config.server.port}`);
      console.error(`Health: http://localhost:${config.server.port}/health`);
    });
  } else {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Smriti MCP server v0.2.0 started (stdio)");
  }
}

runCLI().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
