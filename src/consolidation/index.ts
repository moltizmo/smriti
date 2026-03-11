import type Database from "better-sqlite3";
import type { EmbeddingEngine } from "../embedding/engine.js";
import { getAllThoughts, insertThought, archiveThoughts, updateThoughtTier } from "../db/store.js";
import type { Thought } from "../db/store.js";
import { vectorSearch } from "../db/search.js";
import { RulesExtractor } from "../extraction/rules.js";

export interface ConsolidationResult {
  merged: number;
  promoted: number;
  archived: number;
  groups: Array<{ summary: string; source_ids: string[] }>;
}

const SIMILARITY_THRESHOLD = 0.88;
const MIN_GROUP_SIZE = 3;
const STALE_DAYS = 30;

/** Cosine similarity between two Float32Arrays */
function cosineSim(a: Float32Array, b: Float32Array): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) + 1e-8);
}

/** Summarise a group of thoughts into one representative sentence */
function summariseGroup(thoughts: Thought[]): string {
  // Heuristic: pick the longest thought as the base, then append unique topics
  const base = [...thoughts].sort((a, b) => b.text.length - a.text.length)[0];
  const allTopics = [...new Set(thoughts.flatMap(t => t.topics))].slice(0, 5);
  const topicSuffix = allTopics.length > 0 ? ` [Topics: ${allTopics.join(", ")}]` : "";
  return base.text.trim() + topicSuffix;
}

export async function consolidateMemories(
  db: Database.Database,
  embedder: EmbeddingEngine,
  opts: { dry_run?: boolean; days?: number } = {}
): Promise<ConsolidationResult> {
  const dry = opts.dry_run ?? false;
  const since = new Date(Date.now() - (opts.days ?? 7) * 86400_000).toISOString();

  // 1. Get recent working thoughts
  const thoughts = getAllThoughts(db, { tier: "working", since });
  if (thoughts.length < MIN_GROUP_SIZE) {
    return { merged: 0, promoted: 0, archived: 0, groups: [] };
  }

  // 2. Embed all thoughts (batch)
  const embeddings: Float32Array[] = await Promise.all(
    thoughts.map(t => embedder.embed(t.text))
  );

  // 3. Greedy grouping by similarity
  const used = new Set<number>();
  const groups: Array<{ indices: number[] }> = [];

  for (let i = 0; i < thoughts.length; i++) {
    if (used.has(i)) continue;
    const group = [i];
    for (let j = i + 1; j < thoughts.length; j++) {
      if (used.has(j)) continue;
      if (cosineSim(embeddings[i], embeddings[j]) >= SIMILARITY_THRESHOLD) {
        group.push(j);
        used.add(j);
      }
    }
    if (group.length >= MIN_GROUP_SIZE) {
      group.forEach(idx => used.add(idx));
      groups.push({ indices: group });
    }
  }

  const extractor = new RulesExtractor();
  const mergedGroups: ConsolidationResult["groups"] = [];
  let mergedCount = 0;
  let archivedCount = 0;

  // 4. Merge each group
  for (const group of groups) {
    const groupThoughts = group.indices.map(i => thoughts[i]);
    const summary = summariseGroup(groupThoughts);
    const sourceIds = groupThoughts.map(t => t.id);

    if (!dry) {
      const metadata = extractor.extract(summary);
      metadata.type = "insight";
      const embedding = await embedder.embed(summary);
      insertThought(db, summary, embedding, {
        ...metadata,
        tier: "long_term",
        consolidated_from: sourceIds,
        source: "consolidation",
      });
      archivedCount += archiveThoughts(db, sourceIds);
      mergedCount++;
    }

    mergedGroups.push({ summary, source_ids: sourceIds });
  }

  // 5. Promote well-connected non-grouped working thoughts → long_term
  const staleDate = new Date(Date.now() - STALE_DAYS * 86400_000).toISOString();
  const staleThoughts = getAllThoughts(db, { tier: "working" }).filter(
    t => t.created_at < staleDate
  );

  let promotedCount = 0;
  for (const t of staleThoughts) {
    if (!dry) {
      // Check if this thought has semantic neighbours (suggests it's important)
      const emb = await embedder.embed(t.text);
      const neighbours = vectorSearch(db, emb, { limit: 3 });
      const hasNeighbours = neighbours.filter(n => n.thought.id !== t.id && n.score > 0.75).length >= 2;

      if (hasNeighbours) {
        updateThoughtTier(db, t.id, "long_term");
        promotedCount++;
      } else {
        archiveThoughts(db, [t.id]);
        archivedCount++;
      }
    } else {
      promotedCount++; // dry-run estimate
    }
  }

  return {
    merged: mergedCount,
    promoted: promotedCount,
    archived: archivedCount,
    groups: mergedGroups,
  };
}
