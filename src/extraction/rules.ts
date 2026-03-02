import type { ExtractedMetadata, MetadataExtractor } from "./metadata.js";

// Capitalize words that look like names (adjacent capitalized words)
const NAME_PATTERN =
  /(?:^|[.!?]\s+|,\s+)([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})/g;

// Common non-name capitalized words to exclude
const NON_NAMES = new Set([
  "I", "The", "This", "That", "These", "Those", "There", "Here",
  "What", "When", "Where", "Which", "Who", "How", "Why",
  "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
  "Today", "Tomorrow", "Yesterday",
]);

const ACTION_PATTERNS = [
  /(?:need to|should|must|have to|going to|want to|plan to|will)\s+(.+?)(?:[.!?]|$)/gi,
  /(?:TODO|FIXME|ACTION|TASK):\s*(.+?)(?:[.!?]|$)/gi,
  /(?:remind me to|don't forget to|remember to)\s+(.+?)(?:[.!?]|$)/gi,
];

const TYPE_SIGNALS: Record<string, RegExp[]> = {
  decision: [
    /(?:decided|decision|chose|chosen|going with|settled on)/i,
  ],
  insight: [
    /(?:realized|insight|learned|discovered|turns out|interesting that)/i,
  ],
  person_note: [
    /(?:she|he|they)\s+(?:said|mentioned|told|thinks|believes|wants)/i,
    /(?:meeting with|talked to|spoke with|conversation with)/i,
  ],
  meeting: [
    /(?:meeting|standup|sync|call|discussion|retro|review)\s+(?:about|with|on)/i,
  ],
  idea: [
    /(?:idea|what if|could we|maybe we should|brainstorm|concept)/i,
  ],
  reference: [
    /(?:link|url|http|reference|see also|documentation|docs)/i,
  ],
};

const POSITIVE_WORDS = /(?:great|good|excellent|happy|excited|love|amazing|wonderful|fantastic|successful|win|awesome)/i;
const NEGATIVE_WORDS = /(?:bad|terrible|awful|sad|frustrated|angry|disappointed|failed|broken|wrong|issue|problem|bug)/i;

// Topic extraction: look for quoted strings, hashtags, and key phrases
const TOPIC_PATTERNS = [
  /#(\w+)/g,
  /(?:about|regarding|re:|topic:|project:)\s+["']?([^"'.!?]+)["']?/gi,
];

export class RulesExtractor implements MetadataExtractor {
  extract(text: string): ExtractedMetadata {
    return {
      type: this.classifyType(text),
      people: this.extractPeople(text),
      topics: this.extractTopics(text),
      actions: this.extractActions(text),
      sentiment: this.classifySentiment(text),
    };
  }

  private extractPeople(text: string): string[] {
    const people = new Set<string>();
    let match: RegExpExecArray | null;

    // Reset regex state
    NAME_PATTERN.lastIndex = 0;
    while ((match = NAME_PATTERN.exec(text)) !== null) {
      const name = match[1].trim();
      // Filter out common non-name words
      const firstWord = name.split(" ")[0];
      if (!NON_NAMES.has(firstWord) && name.length > 1) {
        people.add(name);
      }
    }

    // Also look for "Name's" pattern
    const possessivePattern = /([A-Z][a-z]+)'s/g;
    while ((match = possessivePattern.exec(text)) !== null) {
      const name = match[1];
      if (!NON_NAMES.has(name)) {
        people.add(name);
      }
    }

    return [...people];
  }

  private extractTopics(text: string): string[] {
    const topics = new Set<string>();

    for (const pattern of TOPIC_PATTERNS) {
      let match: RegExpExecArray | null;
      pattern.lastIndex = 0;
      while ((match = pattern.exec(text)) !== null) {
        const topic = match[1].trim().toLowerCase();
        if (topic.length > 1 && topic.length < 50) {
          topics.add(topic);
        }
      }
    }

    // If no explicit topics found, extract key noun phrases (simple heuristic)
    if (topics.size === 0) {
      const words = text.toLowerCase().split(/\s+/);
      const stopWords = new Set([
        "the", "a", "an", "is", "are", "was", "were", "be", "been",
        "being", "have", "has", "had", "do", "does", "did", "will",
        "would", "could", "should", "may", "might", "can", "shall",
        "i", "me", "my", "we", "our", "you", "your", "he", "she",
        "it", "they", "them", "his", "her", "its", "to", "of", "in",
        "for", "on", "with", "at", "by", "from", "that", "this",
        "and", "or", "but", "not", "so", "if", "then", "than",
        "about", "just", "also", "very", "really", "quite",
      ]);

      const meaningful = words.filter(
        (w) =>
          w.length > 3 &&
          !stopWords.has(w) &&
          /^[a-z]+$/.test(w)
      );

      // Take top 3 most "topical" words
      for (const word of meaningful.slice(0, 3)) {
        topics.add(word);
      }
    }

    return [...topics];
  }

  private extractActions(text: string): string[] {
    const actions: string[] = [];

    for (const pattern of ACTION_PATTERNS) {
      let match: RegExpExecArray | null;
      pattern.lastIndex = 0;
      while ((match = pattern.exec(text)) !== null) {
        const action = match[1].trim();
        if (action.length > 3 && action.length < 200) {
          actions.push(action);
        }
      }
    }

    return actions;
  }

  private classifyType(text: string): string {
    for (const [type, patterns] of Object.entries(TYPE_SIGNALS)) {
      for (const pattern of patterns) {
        if (pattern.test(text)) return type;
      }
    }
    return "general";
  }

  private classifySentiment(
    text: string
  ): "positive" | "neutral" | "negative" {
    const posMatches = text.match(POSITIVE_WORDS);
    const negMatches = text.match(NEGATIVE_WORDS);
    const posCount = posMatches ? posMatches.length : 0;
    const negCount = negMatches ? negMatches.length : 0;

    if (posCount > negCount) return "positive";
    if (negCount > posCount) return "negative";
    return "neutral";
  }
}
