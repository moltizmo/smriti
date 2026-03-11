/**
 * Credential store for Smriti.
 * Stores tokens in ~/.smriti/credentials (chmod 600) —
 * same pattern as ~/.aws/credentials, ~/.git-credentials.
 * Abstracted behind an interface so we can swap in OS keychain later.
 */
import {
  readFileSync,
  writeFileSync,
  existsSync,
  unlinkSync,
  chmodSync,
} from "node:fs";
import { join } from "node:path";
import { getSmritiDir, ensureSmritiDir } from "../config.js";

const CREDS_FILENAME = "credentials";

function credsPath(): string {
  return join(getSmritiDir(), CREDS_FILENAME);
}

interface CredentialStore {
  github_token?: string;
  github_username?: string;
  sync_repo?: string;
}

function read(): CredentialStore {
  const p = credsPath();
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as CredentialStore;
  } catch {
    return {};
  }
}

function write(store: CredentialStore): void {
  ensureSmritiDir();
  const p = credsPath();
  writeFileSync(p, JSON.stringify(store, null, 2), { encoding: "utf-8", mode: 0o600 });
  // Enforce strict perms (belt + suspenders)
  try { chmodSync(p, 0o600); } catch { /* ignore on Windows */ }
}

export function saveGitHubToken(
  token: string,
  username: string,
  repoFullName: string
): void {
  const store = read();
  store.github_token = token;
  store.github_username = username;
  store.sync_repo = repoFullName;
  write(store);
}

export function getGitHubToken(): string | null {
  return read().github_token ?? null;
}

export function getGitHubUsername(): string | null {
  return read().github_username ?? null;
}

export function getSyncRepo(): string | null {
  return read().sync_repo ?? null;
}

export function clearCredentials(): void {
  const p = credsPath();
  if (existsSync(p)) unlinkSync(p);
}

export function getAuthStatus(): {
  authenticated: boolean;
  username: string | null;
  sync_repo: string | null;
} {
  const store = read();
  return {
    authenticated: !!store.github_token,
    username: store.github_username ?? null,
    sync_repo: store.sync_repo ?? null,
  };
}
