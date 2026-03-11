/**
 * GitHub API client for Smriti sync.
 * Uses fetch (Node 18+) — no extra dependencies.
 * Token scopes required: repo (create/push private repos)
 */

const GITHUB_API = "https://api.github.com";
const SYNC_REPO_NAME = "smriti-memories";

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
