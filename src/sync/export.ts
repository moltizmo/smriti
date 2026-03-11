import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { getAllThoughts } from "../db/store.js";
import type { Thought } from "../db/store.js";

export interface ExportResult {
  thoughts_exported: number;
  files_written: string[];
}

function thoughtToMarkdown(t: Thought): string {
  const lines = [
    `## [${t.type}] — ${t.created_at.slice(0, 10)}`,
    "",
    t.text,
    "",
  ];
  if (t.topics.length > 0) lines.push(`**Topics:** ${t.topics.join(", ")}`);
  if (t.people.length > 0) lines.push(`**People:** ${t.people.join(", ")}`);
  if (t.actions.length > 0) lines.push(`**Actions:** ${t.actions.join("; ")}`);
  lines.push(`**Tier:** ${t.tier}`, `**ID:** ${t.id}`, "");
  return lines.join("\n");
}

export function exportToMarkdown(
  db: Database.Database,
  exportDir: string,
  opts: { since?: string } = {}
): ExportResult {
  const thoughts = getAllThoughts(db, { tier: "active", since: opts.since });
  if (thoughts.length === 0) {
    return { thoughts_exported: 0, files_written: [] };
  }

  mkdirSync(exportDir, { recursive: true });
  mkdirSync(join(exportDir, "memories"), { recursive: true });
  mkdirSync(join(exportDir, "entities"), { recursive: true });

  const filesWritten: string[] = [];

  // Group by date → memories/YYYY-MM-DD.md
  const byDate = new Map<string, Thought[]>();
  for (const t of thoughts) {
    const day = t.created_at.slice(0, 10);
    if (!byDate.has(day)) byDate.set(day, []);
    byDate.get(day)!.push(t);
  }

  for (const [day, dayThoughts] of byDate.entries()) {
    const path = join(exportDir, "memories", `${day}.md`);
    const content = [
      `# Memories — ${day}`,
      "",
      ...dayThoughts.map(thoughtToMarkdown),
    ].join("\n");
    writeFileSync(path, content, "utf-8");
    filesWritten.push(path);
  }

  // long-term.md
  const longTerm = thoughts.filter(t => t.tier === "long_term");
  if (longTerm.length > 0) {
    const path = join(exportDir, "long-term.md");
    const content = [
      "# Long-Term Memories",
      "",
      ...longTerm.map(thoughtToMarkdown),
    ].join("\n");
    writeFileSync(path, content, "utf-8");
    filesWritten.push(path);
  }

  // entities/{name}.md
  const byPerson = new Map<string, Thought[]>();
  for (const t of thoughts) {
    for (const p of t.people) {
      const name = p.trim();
      if (!name) continue;
      if (!byPerson.has(name)) byPerson.set(name, []);
      byPerson.get(name)!.push(t);
    }
  }
  for (const [person, personThoughts] of byPerson.entries()) {
    const safeName = person.replace(/[^a-zA-Z0-9_-]/g, "_");
    const path = join(exportDir, "entities", `${safeName}.md`);
    const content = [
      `# ${person}`,
      "",
      ...personThoughts.map(thoughtToMarkdown),
    ].join("\n");
    writeFileSync(path, content, "utf-8");
    filesWritten.push(path);
  }

  // index.md
  const indexPath = join(exportDir, "index.md");
  writeFileSync(
    indexPath,
    [
      "# Smriti Export Index",
      "",
      `**Last export:** ${new Date().toISOString()}`,
      `**Total thoughts:** ${thoughts.length}`,
      `**Long-term:** ${longTerm.length}`,
      `**Days covered:** ${byDate.size}`,
      `**People tracked:** ${byPerson.size}`,
      "",
      "## Files",
      ...filesWritten.map(f => `- ${f}`),
    ].join("\n"),
    "utf-8"
  );
  filesWritten.push(indexPath);

  return { thoughts_exported: thoughts.length, files_written: filesWritten };
}
