import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

export interface Thought {
  id: string;
  text: string;
  type: string;
  source: string | null;
  people: string[];
  topics: string[];
  actions: string[];
  sentiment: string;
  created_at: string;
  updated_at: string;
}

interface ThoughtRow {
  id: string;
  text: string;
  type: string;
  source: string | null;
  people: string;
  topics: string;
  actions: string;
  sentiment: string;
  created_at: string;
  updated_at: string;
}

function rowToThought(row: ThoughtRow): Thought {
  return {
    ...row,
    people: JSON.parse(row.people) as string[],
    topics: JSON.parse(row.topics) as string[],
    actions: JSON.parse(row.actions) as string[],
  };
}

export function insertThought(
  db: Database.Database,
  text: string,
  embedding: Float32Array,
  metadata: {
    type?: string;
    source?: string;
    people?: string[];
    topics?: string[];
    actions?: string[];
    sentiment?: string;
  }
): Thought {
  const id = `thought_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO thoughts (id, text, type, source, people, topics, actions, sentiment, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    text,
    metadata.type ?? "general",
    metadata.source ?? null,
    JSON.stringify(metadata.people ?? []),
    JSON.stringify(metadata.topics ?? []),
    JSON.stringify(metadata.actions ?? []),
    metadata.sentiment ?? "neutral",
    now,
    now
  );

  // Insert embedding into vector table — sqlite-vec requires rowid via SQL subquery, not JS binding
  db.prepare(
    "INSERT INTO thought_vectors (rowid, embedding) VALUES ((SELECT rowid FROM thoughts WHERE id = ?), ?)"
  ).run(id, Buffer.from(embedding.buffer));

  return {
    id,
    text,
    type: metadata.type ?? "general",
    source: metadata.source ?? null,
    people: metadata.people ?? [],
    topics: metadata.topics ?? [],
    actions: metadata.actions ?? [],
    sentiment: metadata.sentiment ?? "neutral",
    created_at: now,
    updated_at: now,
  };
}

export function getThought(
  db: Database.Database,
  id: string
): Thought | null {
  const row = db
    .prepare("SELECT * FROM thoughts WHERE id = ?")
    .get(id) as ThoughtRow | undefined;
  return row ? rowToThought(row) : null;
}

export function deleteThought(db: Database.Database, id: string): boolean {
  // Delete vector first using subquery
  db.prepare(
    "DELETE FROM thought_vectors WHERE rowid = (SELECT rowid FROM thoughts WHERE id = ?)"
  ).run(id);
  const result = db.prepare("DELETE FROM thoughts WHERE id = ?").run(id);
  return result.changes > 0;
}

export function getRecentThoughts(
  db: Database.Database,
  opts: {
    days?: number;
    type?: string;
    topic?: string;
    person?: string;
    limit?: number;
  }
): Thought[] {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (opts.days) {
    conditions.push("created_at >= datetime('now', ?)");
    params.push(`-${opts.days} days`);
  }
  if (opts.type) {
    conditions.push("type = ?");
    params.push(opts.type);
  }
  if (opts.topic) {
    conditions.push("topics LIKE ?");
    params.push(`%${opts.topic}%`);
  }
  if (opts.person) {
    conditions.push("people LIKE ?");
    params.push(`%${opts.person}%`);
  }

  const where =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = opts.limit ?? 50;

  const rows = db
    .prepare(
      `SELECT * FROM thoughts ${where} ORDER BY created_at DESC LIMIT ?`
    )
    .all(...params, limit) as ThoughtRow[];

  return rows.map(rowToThought);
}

export function getStats(
  db: Database.Database,
  period: "week" | "month" | "all"
): {
  total: number;
  by_type: Record<string, number>;
  top_topics: [string, number][];
  top_people: [string, number][];
  period_count: number;
} {
  const total = (
    db.prepare("SELECT COUNT(*) as cnt FROM thoughts").get() as {
      cnt: number;
    }
  ).cnt;

  const periodFilter =
    period === "all"
      ? ""
      : period === "week"
        ? "WHERE created_at >= datetime('now', '-7 days')"
        : "WHERE created_at >= datetime('now', '-30 days')";

  const periodCount = (
    db
      .prepare(`SELECT COUNT(*) as cnt FROM thoughts ${periodFilter}`)
      .get() as { cnt: number }
  ).cnt;

  const typeRows = db
    .prepare(
      `SELECT type, COUNT(*) as cnt FROM thoughts ${periodFilter} GROUP BY type ORDER BY cnt DESC`
    )
    .all() as { type: string; cnt: number }[];

  const by_type: Record<string, number> = {};
  for (const row of typeRows) {
    by_type[row.type] = row.cnt;
  }

  // Aggregate topics and people from JSON arrays
  const thoughtRows = db
    .prepare(`SELECT topics, people FROM thoughts ${periodFilter}`)
    .all() as { topics: string; people: string }[];

  const topicCounts = new Map<string, number>();
  const peopleCounts = new Map<string, number>();

  for (const row of thoughtRows) {
    for (const t of JSON.parse(row.topics) as string[]) {
      topicCounts.set(t, (topicCounts.get(t) ?? 0) + 1);
    }
    for (const p of JSON.parse(row.people) as string[]) {
      peopleCounts.set(p, (peopleCounts.get(p) ?? 0) + 1);
    }
  }

  const top_topics = [...topicCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10) as [string, number][];

  const top_people = [...peopleCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10) as [string, number][];

  return { total, by_type, top_topics, top_people, period_count: periodCount };
}
