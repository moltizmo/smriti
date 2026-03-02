import type Database from "better-sqlite3";
import type { Thought } from "./store.js";

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

export interface SearchResult {
  thought: Thought;
  distance: number;
  score: number;
}

export function vectorSearch(
  db: Database.Database,
  queryEmbedding: Float32Array,
  opts: {
    limit?: number;
    after?: string;
    type?: string;
  }
): SearchResult[] {
  const limit = opts.limit ?? 5;

  // Get candidate rowids from vector search
  const vecResults = db
    .prepare(
      `SELECT rowid, distance
       FROM thought_vectors
       WHERE embedding MATCH ?
       ORDER BY distance
       LIMIT ?`
    )
    .all(Buffer.from(queryEmbedding.buffer), limit * 3) as {
    rowid: number;
    distance: number;
  }[];

  if (vecResults.length === 0) return [];

  const results: SearchResult[] = [];

  for (const vr of vecResults) {
    const row = db
      .prepare("SELECT * FROM thoughts WHERE rowid = ?")
      .get(vr.rowid) as ThoughtRow | undefined;

    if (!row) continue;

    // Apply filters
    if (opts.after && row.created_at < opts.after) continue;
    if (opts.type && row.type !== opts.type) continue;

    results.push({
      thought: {
        ...row,
        people: JSON.parse(row.people) as string[],
        topics: JSON.parse(row.topics) as string[],
        actions: JSON.parse(row.actions) as string[],
      },
      distance: vr.distance,
      score: Math.max(0, 1 - vr.distance),
    });

    if (results.length >= limit) break;
  }

  return results;
}
