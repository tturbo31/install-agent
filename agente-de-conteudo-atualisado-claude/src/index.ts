import "dotenv/config"
import * as path from "path"
import { fetchRecentVideos } from "./agents/youtube-agent"
import { fetchGitHubProjects } from "./agents/github-agent"
import { analyzeWithClaude } from "./services/claude-analyzer"
import { generatePDF } from "./services/pdf-generator"
import { uploadPDF, saveDailyReport } from "./services/supabase-client"
import { sendEmailReport } from "./services/email-sender"
import {
  initializeMemoryStore,
  readAgentMemory,
  updateAgentMemory,
  buildMemoryContext,
  runDreaming,
  swapMemoryStoreInEnv,
  shouldRunDreaming,
} from "./services/agent-memory"

// ---- Logging ----

function log(message: string): void {
  console.log(`[${new Date().toISOString()}] [Main] ${message}`)
}

function logSection(title: string): void {
  const line = "=".repeat(60)
  console.log(`\n${line}`)
  console.log(`[${new Date().toISOString()}] ${title}`)
  console.log(`${line}`)
}

// ---- Env validation ----

interface Config {
  anthropicApiKey: string
  youtubeApiKey: string
  youtubeChannelId: string
  githubToken: string
  supabaseUrl: string
  supabaseAnonKey: string
  resendApiKey: string
  emailTo: string
  memoryStoreId?: string
}

function loadConfig(): Config {
  const required: Array<[keyof Config, string]> = [
    ["anthropicApiKey", "ANTHROPIC_API_KEY"],
    ["youtubeApiKey", "YOUTUBE_API_KEY"],
    ["githubToken", "GITHUB_TOKEN"],
    ["supabaseUrl", "SUPABASE_URL"],
    ["supabaseAnonKey", "SUPABASE_ANON_KEY"],
    ["resendApiKey", "RESEND_API_KEY"],
    ["emailTo", "EMAIL_TO"],
  ]

  const missing: string[] = []
  const config: Partial<Config> = {}

  for (const [key, envVar] of required) {
    const value = process.env[envVar]?.trim()
    if (!value) {
      missing.push(envVar)
    } else {
      config[key] = value
    }
  }

  config.youtubeChannelId = (process.env["YOUTUBE_CHANNEL_ID"] ?? "UCbmNph6atAoGfqLoCL_duAg").trim()
  config.memoryStoreId = process.env["MEMORY_STORE_ID"]?.trim()

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables:\n${missing.map((v) => `  - ${v}`).join("\n")}\n\nPlease copy .env.example to .env and fill in the values.`
    )
  }

  return config as Config
}

// ---- Main agent ----

export async function runDailyReport(): Promise<void> {
  const startTime = Date.now()
  logSection("CLAUDE CODE DAILY INTELLIGENCE AGENT STARTING")

  // ---- Load config ----
  let config: Config
  try {
    config = loadConfig()
    log("Configuration loaded successfully.")
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`\n[FATAL] ${msg}\n`)
    process.exit(1)
  }

  // ---- Step 0: Initialize & read memory ----
  logSection("STEP 0/7: Memory Store — Loading Prior Knowledge")
  const memoryStoreId = await initializeMemoryStore(config.anthropicApiKey, config.memoryStoreId)
  const priorMemory = await readAgentMemory(config.anthropicApiKey, memoryStoreId)
  const memoryContext = buildMemoryContext(priorMemory)

  log(`Memory loaded. This agent has run ${priorMemory.totalRunsCompleted} time(s) before.`)
  log(`Known videos: ${priorMemory.analyzedVideoIds.length} | Known repos: ${priorMemory.analyzedRepoUrls.length}`)
  log(`Patterns accumulated: ${priorMemory.learnedPatterns.length}`)

  // ---- Step 1: Fetch YouTube videos ----
  logSection("STEP 1/7: YouTube Monitoring")
  let videos: Awaited<ReturnType<typeof fetchRecentVideos>> = []
  let cachedVideosWithFreshAnalysis: Awaited<ReturnType<typeof fetchRecentVideos>> = []
  try {
    // Always fetch last 7 days so we don't miss anything
    const allVideos = await fetchRecentVideos(
      config.youtubeApiKey,
      config.youtubeChannelId,
      config.anthropicApiKey,
      168 // 7 days
    )

    // New = not in memory → send to Claude for structured analysis
    videos = allVideos.filter((v) => !priorMemory.analyzedVideoIds.includes(v.videoId))

    // Known but freshly fetched → save their visualObservations for the dashboard
    cachedVideosWithFreshAnalysis = allVideos.filter((v) =>
      priorMemory.analyzedVideoIds.includes(v.videoId)
    )

    const skipped = cachedVideosWithFreshAnalysis.length
    log(`YouTube step complete: ${allVideos.length} total, ${skipped} already known (will reuse cached analysis), ${videos.length} new to analyze.`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log(`YouTube step failed (non-fatal): ${msg}`)
    log("Continuing without YouTube data...")
  }

  // ---- Step 2: Fetch GitHub projects ----
  logSection("STEP 2/7: GitHub Monitoring")
  let repos: Awaited<ReturnType<typeof fetchGitHubProjects>> = []
  try {
    const allRepos = await fetchGitHubProjects(
      config.githubToken,
      10, // min stars
      7   // days back
    )
    // Skip repos already in memory
    repos = allRepos.filter((r) => !priorMemory.analyzedRepoUrls.includes(r.url))
    const skipped = allRepos.length - repos.length
    log(`GitHub step complete: ${allRepos.length} total, ${skipped} already known, ${repos.length} new to analyze.`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log(`GitHub step failed (non-fatal): ${msg}`)
    log("Continuing without GitHub data...")
  }

  if (videos.length === 0 && repos.length === 0) {
    log("WARNING: No new content found. All recent content was already analyzed.")
    log("The agent will still generate a summary report using accumulated knowledge.")
  }

  // ---- Step 3: Claude analysis (with memory context) ----
  logSection("STEP 3/7: Claude API Analysis + Self-Learning")
  let analysis: Awaited<ReturnType<typeof analyzeWithClaude>>
  try {
    analysis = await analyzeWithClaude(config.anthropicApiKey, videos, repos, memoryContext)

    // Merge cached videos (already in memory, re-fetched) into the insights using fresh visualObservations
    if (cachedVideosWithFreshAnalysis.length > 0) {
      const cachedInsights = cachedVideosWithFreshAnalysis.map((v) => ({
        videoId: v.videoId,
        title: v.title,
        url: v.url,
        summary: v.visualObservations.split("\n").find((l) => l.trim().length > 40)?.trim().slice(0, 220) ?? v.description.slice(0, 220),
        fullAnalysis: v.visualObservations,
        keyFeatures: [],
        visualDemonstrations: [],
        implementationTips: [],
        implementationForOurSystem: v.projectImplementation,
        improvements: [],
        priorityLevel: "medium" as const,
      }))
      analysis.youtubeInsights = [...analysis.youtubeInsights, ...cachedInsights]
      log(`  Merged ${cachedInsights.length} cached video(s) with fresh analysis into the report.`)
    }

    log("Claude analysis complete.")
    log(`  - YouTube insights: ${analysis.youtubeInsights.length}`)
    log(`  - GitHub projects analyzed: ${analysis.githubProjects.length}`)
    log(`  - Priority actions: ${analysis.priorityActions.length}`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[FATAL] Claude analysis failed: ${msg}`)
    throw err
  }

  // ---- Step 4: Generate PDF ----
  logSection("STEP 4/7: PDF Generation")
  const reportsDir = path.resolve(__dirname, "../reports")
  let pdfPath: string
  try {
    pdfPath = await generatePDF(analysis, reportsDir)
    log(`PDF generated: ${pdfPath}`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[FATAL] PDF generation failed: ${msg}`)
    throw err
  }

  // ---- Step 5: Upload PDF + Save to dashboard ----
  logSection("STEP 5/7: Supabase — Upload PDF + Save to Dashboard")
  let publicUrl: string
  try {
    const uploadResult = await uploadPDF(config.supabaseUrl, config.supabaseAnonKey, pdfPath)
    publicUrl = uploadResult.publicUrl
    log(`PDF uploaded: ${publicUrl}`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[FATAL] PDF upload failed: ${msg}`)
    throw err
  }

  // ---- Step 5b: Send email report ----
  logSection("STEP 5b/7: Email Report")
  try {
    await sendEmailReport(config.resendApiKey, config.emailTo, analysis, publicUrl)
    log(`Email report sent to ${config.emailTo}.`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log(`WARNING: Email sending failed (non-fatal): ${msg}`)
    log("Continuing without email...")
  }

  // ---- Step 6: Save analysis to dashboard database ----
  logSection("STEP 6/7: Save Analysis to Dashboard")
  try {
    await saveDailyReport(
      config.supabaseUrl,
      analysis,
      priorMemory.totalRunsCompleted + 1,
      memoryStoreId
    )
    log("Analysis saved — dashboard will show new report immediately.")
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log(`WARNING: Dashboard save failed (non-fatal): ${msg}`)
  }

  // ---- Step 7: Update memory with today's learnings ----
  logSection("STEP 7/7: Memory Update — Saving New Knowledge")
  try {
    await updateAgentMemory(
      config.anthropicApiKey,
      memoryStoreId,
      priorMemory,
      videos.map((v) => v.videoId),
      repos.map((r) => r.url),
      analysis
    )
    log("Memory updated with today's learnings. Agent is now smarter.")
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log(`WARNING: Memory update failed (non-fatal): ${msg}`)
  }

  // ---- Dreaming: weekly memory consolidation (Sundays or every 7 runs) ----
  const runsSoFar = priorMemory.totalRunsCompleted + 1
  if (shouldRunDreaming(runsSoFar)) {
    logSection("DREAMING: Weekly Memory Consolidation")
    log(`Run #${runsSoFar} — Dreaming triggered (Sunday or 7-run milestone).`)
    try {
      const updatedMemory = await readAgentMemory(config.anthropicApiKey, memoryStoreId)
      const dreamedStoreId = await runDreaming(config.anthropicApiKey, memoryStoreId, updatedMemory)

      if (dreamedStoreId !== memoryStoreId) {
        const envPath = path.resolve(__dirname, "../.env")
        await swapMemoryStoreInEnv(envPath, memoryStoreId, dreamedStoreId)
        log(`Memory consolidated into new store: ${dreamedStoreId}`)
        log(`Old store preserved as backup: ${memoryStoreId}`)
        log(`Next run will use the cleaner, dreamed memory store.`)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log(`WARNING: Dreaming failed (non-fatal): ${msg}`)
      log("Agent will continue using the existing memory store.")
    }
  } else {
    log(`Run #${runsSoFar} — Dreaming not triggered today (runs on Sundays or every 7 runs).`)
  }

  // ---- Done ----
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
  logSection("AGENT COMPLETE")
  log(`Total time: ${elapsed}s`)
  log(`PDF: ${pdfPath}`)
  log(`PDF URL: ${publicUrl}`)
  log(`Dashboard: http://localhost:3000`)
  log(`Memory store: ${memoryStoreId}`)
  log(`Agent has now run ${runsSoFar} time(s).`)
  console.log()
}

runDailyReport().catch((err) => {
  console.error(`\n[UNHANDLED ERROR] ${err instanceof Error ? err.message : String(err)}`)
  if (err instanceof Error && err.stack) console.error(err.stack)
  process.exit(1)
})
