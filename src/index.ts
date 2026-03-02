#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, ensureSmritiDir } from "./config.js";
import { initDatabase } from "./db/schema.js";
import { OnnxEmbeddingEngine } from "./embedding/onnx.js";
import { RulesExtractor } from "./extraction/rules.js";
import { createServer } from "./server.js";

async function main() {
  const args = process.argv.slice(2);
  const useHttp = args.includes("--http");
  const portIdx = args.indexOf("--port");
  const port =
    portIdx !== -1 && args[portIdx + 1]
      ? parseInt(args[portIdx + 1], 10)
      : undefined;

  ensureSmritiDir();
  const config = loadConfig();

  if (useHttp) config.server.transport = "http";
  if (port) config.server.port = port;

  const db = initDatabase(config.db_path);
  const embedder = new OnnxEmbeddingEngine();
  const extractor = new RulesExtractor();

  const server = createServer(db, embedder, extractor);

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
      console.error(
        `Smriti MCP server (HTTP) listening on port ${config.server.port}`
      );
    });
  } else {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Smriti MCP server started (stdio)");
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
