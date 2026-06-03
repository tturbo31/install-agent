import { Octokit } from "@octokit/rest"
import { checkSecurity, type SecurityCheckResult } from "../utils/security-checker"

export interface GitHubRepo {
  name: string
  fullName: string
  url: string
  stars: number
  forks: number
  description: string
  readme: string
  packageJson: string | null
  topics: string[]
  language: string | null
  updatedAt: string
  createdAt: string
  hasIssues: boolean
  openIssuesCount: number
  securityCheck: SecurityCheckResult
}

// Topics to search for in the Claude Code ecosystem
const SEARCH_TOPICS = [
  "claude-code",
  "anthropic",
  "mcp-server",
  "claude-agent",
  "claude-claude",
]

function log(message: string): void {
  console.log(`[${new Date().toISOString()}] [GitHubAgent] ${message}`)
}

async function getReadme(octokit: Octokit, owner: string, repo: string): Promise<string> {
  try {
    const response = await octokit.repos.getReadme({ owner, repo })
    const content = Buffer.from(response.data.content, "base64").toString("utf-8")
    // Truncate to 8000 chars to keep prompt manageable
    return content.slice(0, 8000)
  } catch {
    return ""
  }
}

async function getPackageJson(
  octokit: Octokit,
  owner: string,
  repo: string
): Promise<string | null> {
  try {
    const response = await octokit.repos.getContent({
      owner,
      repo,
      path: "package.json",
    })
    if ("content" in response.data && typeof response.data.content === "string") {
      const content = Buffer.from(response.data.content, "base64").toString("utf-8")
      return content.slice(0, 3000)
    }
    return null
  } catch {
    return null
  }
}

function deduplicateRepos(
  repos: Array<{
    id?: number
    full_name?: string
    name?: string
    html_url?: string
    stargazers_count?: number
    forks_count?: number
    description?: string | null
    topics?: string[]
    language?: string | null
    updated_at?: string | null
    created_at?: string | null
    has_issues?: boolean
    open_issues_count?: number
    fork?: boolean
    archived?: boolean
  }>
): typeof repos {
  const seen = new Set<string>()
  return repos.filter((repo) => {
    const key = repo.full_name ?? repo.html_url ?? ""
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export async function fetchGitHubProjects(
  githubToken: string,
  minStars: number = 10,
  daysBack: number = 7
): Promise<GitHubRepo[]> {
  log(`Searching GitHub for Claude Code ecosystem projects (min ${minStars} stars, last ${daysBack} days)...`)

  const octokit = new Octokit({ auth: githubToken })
  const since = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000)
    .toISOString()
    .split("T")[0]

  const allRepoItems: Array<{
    id?: number
    full_name?: string
    name?: string
    html_url?: string
    stargazers_count?: number
    forks_count?: number
    description?: string | null
    topics?: string[]
    language?: string | null
    updated_at?: string | null
    created_at?: string | null
    has_issues?: boolean
    open_issues_count?: number
    fork?: boolean
    archived?: boolean
  }> = []

  // Search by each topic
  for (const topic of SEARCH_TOPICS) {
    try {
      const query = `topic:${topic} stars:>=${minStars} pushed:>=${since} fork:false archived:false`
      log(`Searching: ${query}`)

      const searchResult = await octokit.search.repos({
        q: query,
        sort: "stars",
        order: "desc",
        per_page: 10,
      })

      allRepoItems.push(...searchResult.data.items)
      log(`Found ${searchResult.data.items.length} repos for topic "${topic}"`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log(`Search failed for topic "${topic}": ${msg.slice(0, 100)}`)
    }
  }

  // Also do a keyword search to catch repos without explicit topics
  try {
    const keywordQuery = `claude-code in:name,description stars:>=${minStars} pushed:>=${since} fork:false archived:false`
    const keywordResult = await octokit.search.repos({
      q: keywordQuery,
      sort: "stars",
      order: "desc",
      per_page: 10,
    })
    allRepoItems.push(...keywordResult.data.items)
    log(`Keyword search found ${keywordResult.data.items.length} additional repos`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log(`Keyword search failed: ${msg.slice(0, 100)}`)
  }

  // Deduplicate
  const unique = deduplicateRepos(allRepoItems)
  log(`Total unique repos to process: ${unique.length}`)

  const results: GitHubRepo[] = []

  for (const item of unique) {
    if (!item.full_name || !item.html_url) continue

    const [owner, repoName] = item.full_name.split("/")
    if (!owner || !repoName) continue

    log(`Processing repo: ${item.full_name} (${item.stargazers_count ?? 0} stars)`)

    try {
      const [readme, packageJson] = await Promise.all([
        getReadme(octokit, owner, repoName),
        getPackageJson(octokit, owner, repoName),
      ])

      const security = checkSecurity(readme, packageJson)

      if (!security.passed) {
        log(`Security check FAILED for ${item.full_name} (score: ${security.score}). Flags: ${security.flags.join(", ")}. Skipping.`)
        continue
      }

      results.push({
        name: item.name ?? repoName,
        fullName: item.full_name,
        url: item.html_url,
        stars: item.stargazers_count ?? 0,
        forks: item.forks_count ?? 0,
        description: item.description ?? "",
        readme,
        packageJson,
        topics: item.topics ?? [],
        language: item.language ?? null,
        updatedAt: item.updated_at ?? new Date().toISOString(),
        createdAt: item.created_at ?? new Date().toISOString(),
        hasIssues: item.has_issues ?? false,
        openIssuesCount: item.open_issues_count ?? 0,
        securityCheck: security,
      })

      log(`Added repo: ${item.full_name} (security score: ${security.score})`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log(`Error processing ${item.full_name}: ${msg.slice(0, 150)}. Skipping.`)
    }
  }

  // Sort by stars descending
  results.sort((a, b) => b.stars - a.stars)

  log(`Final curated list: ${results.length} repos passed security check.`)
  return results
}
