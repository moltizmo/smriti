import { execSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { exportToMarkdown, type ExportResult } from "./export.js";
import { getGitHubToken, getGitHubUsername, getSyncRepo } from "../auth/credentials.js";
import { authenticatedCloneUrl } from "../auth/github.js";
import { getSmritiDir } from "../config.js";

export interface SyncResult {
  export: ExportResult;
  committed: boolean;
  pushed: boolean;
  message: string;
}

const SYNC_CLONE_DIR = join(getSmritiDir(), "sync-repo");

function gitExec(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, stdio: "pipe", encoding: "utf-8" }).trim();
}

function isGitRepo(dir: string): boolean {
  try {
    execSync("git rev-parse --is-inside-work-tree", { cwd: dir, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure the sync repo is cloned locally.
 * Uses authenticated HTTPS URL — no SSH keys required.
 */
function ensureLocalClone(cloneUrl: string, username: string, email: string): string {
  if (!existsSync(SYNC_CLONE_DIR)) {
    mkdirSync(SYNC_CLONE_DIR, { recursive: true });
  }

  if (!isGitRepo(SYNC_CLONE_DIR)) {
    execSync(`git clone "${cloneUrl}" .`, {
      cwd: SYNC_CLONE_DIR,
      stdio: "pipe",
    });
  }

  // Set git identity for this repo
  gitExec(`git config user.name "smriti-sync"`, SYNC_CLONE_DIR);
  gitExec(`git config user.email "${email}"`, SYNC_CLONE_DIR);

  // Update remote URL with fresh token (token may have changed)
  gitExec(`git remote set-url origin "${cloneUrl}"`, SYNC_CLONE_DIR);

  return SYNC_CLONE_DIR;
}

export function syncToGit(
  db: Database.Database,
  exportDir: string,
  repoPath: string | null  // legacy: local path. If null, try OAuth path.
): SyncResult {
  // Step 1 — export to Markdown
  const exportResult = exportToMarkdown(db, exportDir);

  // If legacy repoPath provided, use it directly
  if (repoPath) {
    return syncLegacy(exportResult, exportDir, repoPath);
  }

  // OAuth path — use stored credentials
  const token = getGitHubToken();
  const username = getGitHubUsername();
  const syncRepo = getSyncRepo();

  if (!token || !username || !syncRepo) {
    return {
      export: exportResult,
      committed: false,
      pushed: false,
      message: `Not authenticated. Run: npx smriti auth --token <github_pat>`,
    };
  }

  return syncOAuth(exportResult, exportDir, token, username, syncRepo);
}

function syncOAuth(
  exportResult: ExportResult,
  exportDir: string,
  token: string,
  username: string,
  repoFullName: string
): SyncResult {
  try {
    const cloneUrl = authenticatedCloneUrl(token, username, repoFullName);
    const repoDir = ensureLocalClone(cloneUrl, username, `${username}@users.noreply.github.com`);

    // Copy exported files into the cloned repo
    execSync(`cp -r "${exportDir}/." "${repoDir}/"`, { stdio: "pipe" });

    // Pull latest (avoid conflicts)
    try {
      gitExec("git pull --rebase origin main", repoDir);
    } catch { /* repo may be empty on first sync */ }

    gitExec("git add -A", repoDir);
    const diff = gitExec("git status --porcelain", repoDir);

    if (!diff) {
      return {
        export: exportResult,
        committed: false,
        pushed: false,
        message: `Nothing to commit — memory already up to date.`,
      };
    }

    const timestamp = new Date().toISOString().slice(0, 16).replace("T", " ");
    const commitMsg = `smriti: sync ${timestamp} (${exportResult.thoughts_exported} thoughts)`;
    gitExec(`git commit -m "${commitMsg}"`, repoDir);

    try {
      gitExec("git push origin main", repoDir);
      return {
        export: exportResult,
        committed: true,
        pushed: true,
        message: `✅ Synced ${exportResult.thoughts_exported} thoughts → github.com/${repoFullName}`,
      };
    } catch (pushErr) {
      // Try setting upstream on first push
      try {
        gitExec("git push --set-upstream origin main", repoDir);
        return {
          export: exportResult,
          committed: true,
          pushed: true,
          message: `✅ Synced ${exportResult.thoughts_exported} thoughts → github.com/${repoFullName}`,
        };
      } catch {
        return {
          export: exportResult,
          committed: true,
          pushed: false,
          message: `Committed but push failed: ${String(pushErr)}`,
        };
      }
    }
  } catch (err) {
    return {
      export: exportResult,
      committed: false,
      pushed: false,
      message: `Sync error: ${String(err)}`,
    };
  }
}

function syncLegacy(
  exportResult: ExportResult,
  exportDir: string,
  repoPath: string
): SyncResult {
  if (!existsSync(repoPath) || !isGitRepo(repoPath)) {
    return {
      export: exportResult,
      committed: false,
      pushed: false,
      message: `repo_path not found or not a git repo: ${repoPath}`,
    };
  }

  try {
    const timestamp = new Date().toISOString().slice(0, 16).replace("T", " ");
    const commitMsg = `smriti: sync ${timestamp} (${exportResult.thoughts_exported} thoughts)`;

    gitExec("git add -A", repoPath);
    const diff = gitExec("git status --porcelain", repoPath);
    if (!diff) {
      return { export: exportResult, committed: false, pushed: false, message: "Nothing to commit." };
    }

    gitExec(`git commit -m "${commitMsg}"`, repoPath);

    try {
      gitExec("git push origin main", repoPath);
      return { export: exportResult, committed: true, pushed: true, message: `✅ Synced to ${repoPath}` };
    } catch (err) {
      return { export: exportResult, committed: true, pushed: false, message: `Committed, push failed: ${String(err)}` };
    }
  } catch (err) {
    return { export: exportResult, committed: false, pushed: false, message: `Git error: ${String(err)}` };
  }
}
