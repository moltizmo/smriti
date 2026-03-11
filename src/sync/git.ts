import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import type Database from "better-sqlite3";
import { exportToMarkdown, type ExportResult } from "./export.js";

export interface SyncResult {
  export: ExportResult;
  committed: boolean;
  pushed: boolean;
  message: string;
}

function isGitRepo(dir: string): boolean {
  try {
    execSync("git rev-parse --is-inside-work-tree", { cwd: dir, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function gitExec(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, stdio: "pipe", encoding: "utf-8" }).trim();
}

export function syncToGit(
  db: Database.Database,
  exportDir: string,
  repoPath: string | null
): SyncResult {
  // Step 1 — export to Markdown
  const exportResult = exportToMarkdown(db, exportDir);

  if (!repoPath) {
    return {
      export: exportResult,
      committed: false,
      pushed: false,
      message: `Exported ${exportResult.thoughts_exported} thoughts to ${exportDir}. No repo_path configured — skipping git push.`,
    };
  }

  if (!existsSync(repoPath)) {
    return {
      export: exportResult,
      committed: false,
      pushed: false,
      message: `repo_path does not exist: ${repoPath}`,
    };
  }

  if (!isGitRepo(repoPath)) {
    return {
      export: exportResult,
      committed: false,
      pushed: false,
      message: `${repoPath} is not a git repository. Run: git init && git remote add origin <url>`,
    };
  }

  const timestamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  const commitMsg = `smriti: sync ${timestamp} (${exportResult.thoughts_exported} thoughts)`;

  try {
    gitExec("git add -A", repoPath);
    const diff = gitExec("git status --porcelain", repoPath);

    if (!diff) {
      return {
        export: exportResult,
        committed: false,
        pushed: false,
        message: `Nothing to commit — memory already up to date.`,
      };
    }

    gitExec(`git commit -m "${commitMsg}"`, repoPath);

    try {
      gitExec("git push origin main", repoPath);
      return {
        export: exportResult,
        committed: true,
        pushed: true,
        message: `✅ Synced: ${exportResult.thoughts_exported} thoughts exported, committed, and pushed to origin/main.`,
      };
    } catch (pushErr) {
      return {
        export: exportResult,
        committed: true,
        pushed: false,
        message: `Committed locally but push failed. Run 'git push' manually in ${repoPath}. Error: ${String(pushErr)}`,
      };
    }
  } catch (err) {
    return {
      export: exportResult,
      committed: false,
      pushed: false,
      message: `Git error: ${String(err)}`,
    };
  }
}
