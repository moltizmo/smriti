/**
 * GitHub API client for Smriti sync.
 * Uses fetch (Node 18+) — no extra dependencies.
 * Token scopes required: repo (create/push private repos)
 */

const GITHUB_API = "https://api.github.com";
const SYNC_REPO_NAME = "smriti-memories";

// Register at: https://github.com/settings/developers → OAuth Apps
// Enable "Device Flow" on the app. Client ID is public — no secret needed.
// Override with SMRITI_CLIENT_ID env var for forks/custom deployments.
const OAUTH_CLIENT_ID =
  process.env["SMRITI_CLIENT_ID"] ?? "Ov23liYOUR_CLIENT_ID_HERE";

// ── Device Flow ─────────────────────────────────────────────────────────────

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

/** Step 1: Request a device code from GitHub */
export async function requestDeviceCode(): Promise<DeviceCodeResponse> {
  const res = await fetch("https://github.com/login/device/code", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: OAUTH_CLIENT_ID,
      scope: "repo",
    }),
  });

  if (!res.ok) {
    throw new Error(`GitHub device code request failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json() as DeviceCodeResponse & { error?: string };
  if (data.error) {
    throw new Error(`GitHub error: ${data.error}`);
  }
  return data;
}

export type TokenPollResult =
  | { status: "complete"; token: string }
  | { status: "pending" }
  | { status: "expired" }
  | { status: "error"; message: string };

/** Step 2: Poll until user completes browser auth */
export async function pollForToken(
  deviceCode: string,
  intervalSec: number
): Promise<string> {
  const deadline = Date.now() + 10 * 60 * 1000; // 10 min max

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, intervalSec * 1000));

    const res = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id: OAUTH_CLIENT_ID,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });

    const data = await res.json() as { access_token?: string; error?: string };

    if (data.access_token) return data.access_token;

    if (data.error === "authorization_pending") continue;
    if (data.error === "slow_down") { await new Promise(r => setTimeout(r, 5000)); continue; }
    if (data.error === "expired_token") throw new Error("Device code expired. Run smriti auth again.");
    if (data.error === "access_denied") throw new Error("Access denied by user.");
    if (data.error) throw new Error(`GitHub error: ${data.error}`);
  }

  throw new Error("Auth timed out. Run smriti auth again.");
}

export function hasClientId(): boolean {
  return OAUTH_CLIENT_ID !== "Ov23liYOUR_CLIENT_ID_HERE";
}

async function ghFetch(
  path: string,
  token: string,
  opts: RequestInit = {}
): Promise<Response> {
  return fetch(`${GITHUB_API}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      ...(opts.headers ?? {}),
    },
  });
}

export interface GitHubUser {
  login: string;
  name: string | null;
  email: string | null;
}

export async function getAuthenticatedUser(token: string): Promise<GitHubUser> {
  const res = await ghFetch("/user", token);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub auth failed (${res.status}): ${body}`);
  }
  const data = (await res.json()) as { login: string; name?: string; email?: string };
  return { login: data.login, name: data.name ?? null, email: data.email ?? null };
}

export interface SyncRepo {
  full_name: string;
  clone_url: string;
  html_url: string;
  private: boolean;
}

export async function ensureSyncRepo(token: string, username: string): Promise<SyncRepo> {
  // Check if repo already exists
  const checkRes = await ghFetch(`/repos/${username}/${SYNC_REPO_NAME}`, token);

  if (checkRes.ok) {
    const repo = (await checkRes.json()) as SyncRepo;
    return repo;
  }

  if (checkRes.status !== 404) {
    throw new Error(`GitHub API error: ${checkRes.status} ${await checkRes.text()}`);
  }

  // Create the repo
  const createRes = await ghFetch("/user/repos", token, {
    method: "POST",
    body: JSON.stringify({
      name: SYNC_REPO_NAME,
      description: "Smriti persistent memory sync — auto-managed by npx smriti",
      private: true,
      auto_init: true,
    }),
  });

  if (!createRes.ok) {
    throw new Error(`Failed to create sync repo: ${createRes.status} ${await createRes.text()}`);
  }

  const repo = (await createRes.json()) as SyncRepo;
  console.log(`✅ Created private repo: ${repo.html_url}`);
  return repo;
}

/**
 * Build an authenticated HTTPS clone URL.
 * Format: https://{username}:{token}@github.com/{owner}/{repo}.git
 * This avoids SSH key setup entirely.
 */
export function authenticatedCloneUrl(token: string, username: string, repoFullName: string): string {
  return `https://${username}:${token}@github.com/${repoFullName}.git`;
}
