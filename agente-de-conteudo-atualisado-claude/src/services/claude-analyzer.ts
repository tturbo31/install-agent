import Anthropic from "@anthropic-ai/sdk"
import type { VideoData } from "../agents/youtube-agent"
import type { GitHubRepo } from "../agents/github-agent"

export interface YouTubeInsight {
  videoId: string
  title: string
  url: string
  summary: string
  fullAnalysis: string           // Complete detailed analysis of the video
  keyFeatures: string[]
  visualDemonstrations: string[]
  implementationTips: string[]
  implementationForOurSystem: string  // How to apply this in our agent system
  improvements: string[]         // What improvements/benefits this brings
  priorityLevel: "high" | "medium" | "low"
}

export interface GitHubProjectAnalysis {
  name: string
  url: string
  stars: number
  description: string
  whatItDoes: string
  improvements: string[]
  howToImplement: string[]
  implementationForOurSystem: string
  priority: "high" | "medium" | "low"
  worthImplementing: boolean
}

export interface AnalysisResult {
  youtubeInsights: YouTubeInsight[]
  githubProjects: GitHubProjectAnalysis[]
  implementationGuide: string
  priorityActions: string[]
  executiveSummary: string
  analysisDate: string
}

function log(message: string): void {
  console.log(`[${new Date().toISOString()}] [ClaudeAnalyzer] ${message}`)
}

function buildYouTubeSection(videos: VideoData[]): string {
  if (videos.length === 0) return "No new YouTube videos found in the last 24 hours.\n"

  return videos
    .map((v) => {
      const transcriptPreview = v.transcript
        ? `TRANSCRIPT (first 3000 chars):\n${v.transcript.slice(0, 3000)}`
        : "TRANSCRIPT: Not available."
      return `---
VIDEO: ${v.title}
URL: ${v.url}
PUBLISHED: ${v.publishedAt}
DURATION: ${v.duration}
DESCRIPTION: ${v.description.slice(0, 500)}
${transcriptPreview}
VISUAL OBSERVATIONS (from frame analysis):
${v.visualObservations}
---`
    })
    .join("\n\n")
}

function buildGitHubSection(repos: GitHubRepo[]): string {
  if (repos.length === 0) return "No new GitHub projects found matching the criteria.\n"

  return repos
    .map((r) => {
      const readmePreview = r.readme
        ? `README (first 2000 chars):\n${r.readme.slice(0, 2000)}`
        : "README: Not available."
      const pkgInfo = r.packageJson
        ? `PACKAGE.JSON (first 500 chars):\n${r.packageJson.slice(0, 500)}`
        : ""
      return `---
REPO: ${r.fullName}
URL: ${r.url}
STARS: ${r.stars} | FORKS: ${r.forks}
LANGUAGE: ${r.language ?? "Unknown"}
TOPICS: ${r.topics.join(", ")}
DESCRIPTION: ${r.description}
LAST UPDATED: ${r.updatedAt}
SECURITY SCORE: ${r.securityCheck.score}/100
${readmePreview}
${pkgInfo}
---`
    })
    .join("\n\n")
}

export async function analyzeWithClaude(
  apiKey: string,
  videos: VideoData[],
  repos: GitHubRepo[],
  memoryContext = ""
): Promise<AnalysisResult> {
  log("Starting Claude analysis...")
  log(`Input: ${videos.length} video(s), ${repos.length} GitHub repo(s)`)

  const client = new Anthropic({ apiKey })

  const systemPrompt = `You are an expert AI developer intelligence analyst specializing in the Claude Code ecosystem, Anthropic's AI products, and MCP (Model Context Protocol) development.

Your job is to analyze daily intelligence gathered from Anthropic's YouTube channel and GitHub repositories, then produce a structured JSON report that helps developers:
1. Stay current with Claude Code features and best practices
2. Identify valuable open-source tools and patterns to implement
3. Get actionable implementation guidance

You produce precise, technical, developer-focused analysis. You prioritize practical implementation value over marketing speak.
You always respond with valid JSON matching the exact schema requested.`

  const userPrompt = `Analyze the following daily intelligence data and produce a structured JSON report.

=== AGENT MEMORY & PRIOR KNOWLEDGE ===
${memoryContext || "This is the first run — no prior knowledge exists yet."}



=== YOUTUBE INTELLIGENCE ===
${buildYouTubeSection(videos)}

=== GITHUB INTELLIGENCE ===
${buildGitHubSection(repos)}

=== REQUIRED OUTPUT FORMAT ===
Respond with ONLY valid JSON matching this exact TypeScript interface (no markdown fences, no extra text):

{
  "youtubeInsights": [
    {
      "videoId": "string",
      "title": "string",
      "url": "string",
      "summary": "2-3 sentence technical summary of what was taught",
      "fullAnalysis": "COMPLETE and DETAILED analysis of the video in Portuguese (minimum 400 words). Cover: what was demonstrated, all technical concepts explained, who it is for, and what changed in the Claude ecosystem with this content.",
      "keyFeatures": ["List of ALL Claude Code features/APIs demonstrated — be exhaustive"],
      "visualDemonstrations": ["List of specific things shown on screen/in the demo"],
      "implementationTips": ["Concrete, copy-pasteable tips from this video — minimum 4 tips per video"],
      "implementationForOurSystem": "Detailed guide in Portuguese (minimum 300 words) explaining EXACTLY how to implement what was taught in this video in our daily content intelligence agent system. Mention specific files to modify, code patterns to adopt, and APIs to call.",
      "improvements": ["List of specific improvements and benefits this video's content brings to agent development — minimum 5 items"],
      "priorityLevel": "high | medium | low"
    }
  ],
  "githubProjects": [
    {
      "name": "string",
      "url": "string",
      "stars": 0,
      "description": "string",
      "whatItDoes": "Technical explanation of the project's functionality",
      "improvements": ["What improvements/innovations this offers over standard approaches — minimum 4 items"],
      "howToImplement": ["Step-by-step implementation steps for a developer — minimum 5 steps"],
      "implementationForOurSystem": "Detailed guide in Portuguese (minimum 300 words) explaining EXACTLY how to integrate this GitHub project into our real systems. Cover: (1) How it improves the Daily Content Agent (agente-de-conteudo-atualisado-claude) — which files to modify, what code to add; (2) How it applies to the Instagram DM Agent (instagram-dm-agent) — specific integration with webhooks and Supabase; (3) How it helps build the Medicine Platform — multiple agents, scaling to thousands of users. Be specific about file names, code patterns, and measurable benefits.",
      "priority": "high | medium | low",
      "worthImplementing": true
    }
  ],
  "implementationGuide": "Comprehensive markdown guide (800-1200 words) on how to integrate today's discoveries into an existing Claude Code application. Include code snippets where relevant.",
  "priorityActions": ["Top 5 specific, actionable tasks a developer should do TODAY based on this intelligence"],
  "executiveSummary": "3-4 sentence executive summary of today's most important Claude Code ecosystem developments"
}`

  log("Sending analysis request to Claude (with prompt caching)...")

  try {
    // Use streaming for better visibility into the response
    let fullText = ""

    const stream = await client.messages.create({
      model: "claude-opus-4-5",
      max_tokens: 8000,
      system: [
        {
          type: "text",
          text: systemPrompt,
          // Cache the system prompt — it's static and re-used on every daily run
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content: userPrompt }],
      stream: true,
    })

    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        fullText += event.delta.text
        process.stdout.write(".")
      }
    }
    console.log() // newline after dots

    log(`Received ${fullText.length} chars from Claude.`)

    // Parse the JSON response
    // Claude sometimes wraps in markdown even when told not to — strip if present
    const cleaned = fullText
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "")
      .trim()

    let parsed: Omit<AnalysisResult, "analysisDate">
    try {
      parsed = JSON.parse(cleaned) as Omit<AnalysisResult, "analysisDate">
    } catch (parseErr) {
      log(`JSON parse failed. Raw response preview: ${fullText.slice(0, 500)}`)
      throw new Error(`Claude returned invalid JSON: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`)
    }

    // Enrich each insight with the deep per-video analysis already generated by youtube-agent
    // (stored in visualObservations). Use it as fullAnalysis if Claude didn't fill it or it's thin.
    const videoObservations = new Map(videos.map((v) => [v.videoId, v.visualObservations]))
    const enrichedInsights = parsed.youtubeInsights.map((insight) => {
      const preAnalysis = videoObservations.get(insight.videoId) ?? ""
      return {
        ...insight,
        fullAnalysis: (insight.fullAnalysis && insight.fullAnalysis.length > 200)
          ? insight.fullAnalysis
          : preAnalysis || insight.fullAnalysis,
        implementationForOurSystem: insight.implementationForOurSystem ?? "",
        improvements: insight.improvements ?? [],
        priorityLevel: insight.priorityLevel ?? "medium",
      }
    })

    const result: AnalysisResult = {
      ...parsed,
      youtubeInsights: enrichedInsights,
      analysisDate: new Date().toISOString(),
    }

    log(`Analysis complete. ${result.youtubeInsights.length} video insights, ${result.githubProjects.length} project analyses.`)
    return result
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log(`Claude analysis failed: ${msg}`)
    throw err
  }
}
