import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import type { EmbeddingEngine } from "../embedding/engine.js";
import { insertThought, getThought } from "../db/store.js";
import { RulesExtractor } from "../extraction/rules.js";

export interface ImportResult {
  imported: number;
  skipped: number;
  errors: number;
}

interface ParsedThought {
  id: string;
  text: string;
  type: string;
  tier: string;
  topics: string[];
  people: string[];
}

/** Parse a single thought block from markdown */
function parseThoughtBlock(block: string): ParsedThought | null {
  try {
    const idMatch = block.match(/\*\*ID:\*\*\s*(thought_\S+)/);
    const typeMatch = block.match(/^##\s+\[([^\]]+)\]/m);
    const tierMatch = block.match(/\*\*Tier:\*\*\s*(\S+)/);
    const topicsMatch = block.match(/\*\*Topics:\*\*\s*(.+)/);
    const peopleMatch = block.match(/\*\*People:\*\*\s*(.+)/);

    if (!idMatch) return null;

    // Extract text: everything after the header line until the first **Field:** line
    const lines = block.split("\n");
    const textLines: string[] = [];
    let inText = false;
    for (const line of lines) {
      if (line.startsWith("## ")) { inText = true; continue; }
      if (line.startsWith("**") && line.includes(":**")) break;
      if (inText && line.trim()) textLines.push(line);
    }

    const text = textLines.join("\n").trim();
    if (!text) return null;

    return {
      id: idMatch[1],
      text,
      type: typeMatch?.[1] ?? "general",
      tier: tierMatch?.[1] ?? "working",
      topics: topicsMatch ? topicsMatch[1].split(",").map(s => s.trim()) : [],
      people: peopleMatch ? peopleMatch[1].split(",").map(s => s.trim()) : [],
    };
  } catch {
    return null;
  }
}

export async function importFromMarkdown(
  db: Database.Database,
  embedder: EmbeddingEngine,
  importDir: string
): Promise<ImportResult> {
  if (!existsSync(importDir)) {
    return { imported: 0, skipped: 0, errors: 0 };
  }

  const extractor = new RulesExtractor();
  let imported = 0, skipped = 0, errors = 0;

  // Walk all .md files recursively
  function walkDir(dir: string): string[] {
    const files: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) files.push(...walkDir(fullPath));
      else if (entry.isFile() && entry.name.endsWith(".md") && entry.name !== "index.md") {
        files.push(fullPath);
      }
    }
    return files;
  }

  const mdFiles = walkDir(importDir);

  for (const filePath of mdFiles) {
    let content: string;
    try {
      content = readFileSync(filePath, "utf-8");
    } catch {
      errors++;
      continue;
    }

    // Split on "## [" to get thought blocks
    const blocks = content.split(/\n(?=## \[)/).filter(b => b.trim());

    for (const block of blocks) {
      try {
        const parsed = parseThoughtBlock(block);
        if (!parsed) continue;

        // Dedup by ID
        if (getThought(db, parsed.id)) {
          skipped++;
          continue;
        }

        const metadata = extractor.extract(parsed.text);
        metadata.type = parsed.type;
        if (parsed.topics.length > 0) metadata.topics = parsed.topics;
        if (parsed.people.length > 0) metadata.people = parsed.people;

        const embedding = await embedder.embed(parsed.text);
        insertThought(db, parsed.text, embedding, {
          ...metadata,
          tier: (parsed.tier as "working" | "long_term" | "archived"),
          source: "import",
        });
        imported++;
      } catch {
        errors++;
      }
    }
  }

  return { imported, skipped, errors };
}
