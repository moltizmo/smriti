import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface SmritiConfig {
  db_path: string;
  embedding: {
    provider: "onnx";
    model: string;
  };
  extraction: {
    provider: "rules" | "llm";
  };
  server: {
    transport: "stdio" | "http";
    port: number;
  };
  sync: {
    export_dir: string;
    repo_path: string | null;
    auto_sync_hours: number | null;
  };
}

const SMRITI_DIR = join(homedir(), ".smriti");
const CONFIG_PATH = join(SMRITI_DIR, "config.json");

const DEFAULT_CONFIG: SmritiConfig = {
  db_path: join(SMRITI_DIR, "brain.db"),
  embedding: {
    provider: "onnx",
    model: "Xenova/all-MiniLM-L6-v2",
  },
  extraction: {
    provider: "rules",
  },
  server: {
    transport: "stdio",
    port: 3838,
  },
  sync: {
    export_dir: join(SMRITI_DIR, "export"),
    repo_path: null,
    auto_sync_hours: null,
  },
};

export function ensureSmritiDir(): void {
  if (!existsSync(SMRITI_DIR)) {
    mkdirSync(SMRITI_DIR, { recursive: true });
  }
}

export function loadConfig(): SmritiConfig {
  ensureSmritiDir();
  if (existsSync(CONFIG_PATH)) {
    try {
      const raw = readFileSync(CONFIG_PATH, "utf-8");
      const parsed = JSON.parse(raw) as Partial<SmritiConfig>;
      return { ...DEFAULT_CONFIG, ...parsed };
    } catch {
      return DEFAULT_CONFIG;
    }
  }
  writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
  return DEFAULT_CONFIG;
}

export function getSmritiDir(): string {
  return SMRITI_DIR;
}
