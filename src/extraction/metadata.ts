export interface ExtractedMetadata {
  type: string;
  people: string[];
  topics: string[];
  actions: string[];
  sentiment: "positive" | "neutral" | "negative";
}

export interface MetadataExtractor {
  extract(text: string): ExtractedMetadata;
}
