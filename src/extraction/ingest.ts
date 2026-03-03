/**
 * Conversation ingestion — extracts multiple memories from a conversation chunk.
 * This is the core of auto-capture: agents call ingest() with conversation text
 * and Smriti pulls out everything worth remembering.
 */

export interface IngestableItem {
  text: string;
  type: string;
  confidence: number;
}

// Patterns that signal memorable content
const DECISION_SIGNALS = [
  /(?:decided|decision|going with|settled on|chose|choosing|we'll use|let's go with|the plan is)/i,
  /(?:instead of|rather than|over|versus)\s+\w/i,
];

const PERSON_SIGNALS = [
  /(?:with|from|told|asked|met|called|emailed)\s+([A-Z][a-z]+)/,
  /([A-Z][a-z]+)\s+(?:said|mentioned|thinks|believes|wants|suggested|recommended|proposed)/,
  /([A-Z][a-z]+)'s\s+(?:idea|suggestion|feedback|opinion|concern|point|take)/,
];

const INSIGHT_SIGNALS = [
  /(?:realized|turns out|interesting|surprising|learned|discovered|key takeaway|TIL|the key is)/i,
  /(?:\d+%|\d+x|\$\d+)/i, // numbers, stats, costs
];

const ACTION_SIGNALS = [
  /(?:TODO|FIXME|need to|should|must|have to|going to|will|plan to|don't forget)/i,
  /(?:follow up|circle back|check on|review|update|fix|build|create|deploy|test|migrate)/i,
];

const PREFERENCE_SIGNALS = [
  /(?:prefer|always use|never use|like|dislike|my go-to|favorite|hate|avoid)/i,
  /(?:works better|doesn't work|best approach|worst approach|pro tip)/i,
];

const REFERENCE_SIGNALS = [
  /(?:https?:\/\/\S+)/i,
  /(?:see also|reference|documentation|docs|link|article|paper|repo|repository)/i,
];

const MEETING_SIGNALS = [
  /(?:meeting|standup|sync|call|discussion|retro|review|1:1|one-on-one)\s+(?:about|with|on|regarding)/i,
  /(?:agenda|action items|minutes|notes from|takeaways from)/i,
];

const SKIP_PATTERNS = [
  /^(?:ok|okay|sure|thanks|thank you|got it|yes|no|yeah|nah|hmm|hm|lol|haha)\.?$/i,
  /^(?:sounds good|will do|on it|done|noted)\.?$/i,
  /^\s*$/,
];

/**
 * Split a conversation into individual messages.
 * Handles common formats: "User: ...", "Assistant: ...", newline-separated, etc.
 */
function splitMessages(conversation: string): string[] {
  // Try structured format first (User:/Assistant:/Human:/AI:)
  const structuredPattern = /(?:^|\n)(?:User|Human|Assistant|AI|System|Agent|Me|You):\s*/gi;
  if (structuredPattern.test(conversation)) {
    return conversation
      .split(/\n(?=(?:User|Human|Assistant|AI|System|Agent|Me|You):)/gi)
      .filter((m) => {
        // Only keep user/human messages — skip assistant/AI responses
        const isAssistant = /^(?:Assistant|AI|System|Agent):/i.test(m.trim());
        return !isAssistant;
      })
      .map((m) => m.replace(/^(?:User|Human|Me|You):\s*/i, "").trim())
      .filter((m) => m.length > 10);
  }

  // Fall back to paragraph splitting
  return conversation
    .split(/\n\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 10);
}

/**
 * Score a text segment for memorability. Higher = more worth capturing.
 */
function scoreSegment(text: string): { type: string; confidence: number } {
  let bestType = "general";
  let bestScore = 0;

  const checks: [RegExp[], string, number][] = [
    [DECISION_SIGNALS, "decision", 0.9],
    [MEETING_SIGNALS, "meeting", 0.85],
    [INSIGHT_SIGNALS, "insight", 0.8],
    [ACTION_SIGNALS, "general", 0.75], // actions are captured but typed by content
    [PERSON_SIGNALS, "person_note", 0.7],
    [PREFERENCE_SIGNALS, "insight", 0.7],
    [REFERENCE_SIGNALS, "reference", 0.65],
  ];

  for (const [patterns, type, weight] of checks) {
    for (const pat of patterns) {
      if (pat.test(text)) {
        if (weight > bestScore) {
          bestScore = weight;
          bestType = type;
        }
      }
    }
  }

  // Boost for length (longer = more context = more valuable)
  if (text.length > 200) bestScore = Math.min(1, bestScore + 0.1);
  
  // Boost for specificity (proper nouns, numbers)
  const properNouns = text.match(/[A-Z][a-z]+/g)?.length ?? 0;
  const numbers = text.match(/\d+/g)?.length ?? 0;
  if (properNouns > 2 || numbers > 1) bestScore = Math.min(1, bestScore + 0.1);

  return { type: bestType, confidence: bestScore };
}

/**
 * Check if a segment should be skipped (too short, too generic, just chatter).
 */
function shouldSkip(text: string): boolean {
  if (text.length < 15) return true;
  for (const pat of SKIP_PATTERNS) {
    if (pat.test(text.trim())) return true;
  }
  return false;
}

/**
 * Deduplicate items by checking semantic overlap (simple word overlap).
 */
function dedup(items: IngestableItem[]): IngestableItem[] {
  const result: IngestableItem[] = [];
  for (const item of items) {
    const words = new Set(item.text.toLowerCase().split(/\s+/).filter((w) => w.length > 3));
    const isDup = result.some((existing) => {
      const existingWords = new Set(
        existing.text.toLowerCase().split(/\s+/).filter((w) => w.length > 3)
      );
      const overlap = [...words].filter((w) => existingWords.has(w)).length;
      const similarity = overlap / Math.max(words.size, existingWords.size);
      return similarity > 0.6;
    });
    if (!isDup) result.push(item);
  }
  return result;
}

/**
 * Main ingestion function: takes a conversation and returns items worth capturing.
 * Threshold controls minimum confidence (0-1). Default 0.5.
 */
export function extractMemories(
  conversation: string,
  threshold: number = 0.5
): IngestableItem[] {
  const segments = splitMessages(conversation);
  const candidates: IngestableItem[] = [];

  for (const segment of segments) {
    if (shouldSkip(segment)) continue;

    // Try to split compound sentences for better granularity
    const sentences = segment
      .split(/(?<=[.!?])\s+/)
      .filter((s) => s.length > 15);

    if (sentences.length > 3) {
      // Long segment: score individual sentences, combine related ones
      let currentGroup: string[] = [];
      let currentType = "general";

      for (const sentence of sentences) {
        const { type, confidence } = scoreSegment(sentence);
        if (confidence >= threshold) {
          if (type !== currentType && currentGroup.length > 0) {
            candidates.push({
              text: currentGroup.join(" "),
              type: currentType,
              confidence: scoreSegment(currentGroup.join(" ")).confidence,
            });
            currentGroup = [];
          }
          currentType = type;
          currentGroup.push(sentence);
        }
      }
      if (currentGroup.length > 0) {
        candidates.push({
          text: currentGroup.join(" "),
          type: currentType,
          confidence: scoreSegment(currentGroup.join(" ")).confidence,
        });
      }
    } else {
      // Short segment: score as a whole
      const { type, confidence } = scoreSegment(segment);
      if (confidence >= threshold) {
        candidates.push({ text: segment, type, confidence });
      }
    }
  }

  // Sort by confidence, dedup, return
  candidates.sort((a, b) => b.confidence - a.confidence);
  return dedup(candidates);
}
