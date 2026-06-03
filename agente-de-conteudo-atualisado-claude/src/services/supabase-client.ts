import { createClient, type SupabaseClient } from "@supabase/supabase-js"
import * as fs from "fs"
import * as path from "path"

const BUCKET_NAME = "daily-reports"

function log(message: string): void {
  console.log(`[${new Date().toISOString()}] [SupabaseClient] ${message}`)
}

let supabaseAdmin: SupabaseClient | null = null
let supabaseAnon: SupabaseClient | null = null

function getAdminClient(url: string): SupabaseClient {
  if (!supabaseAdmin) {
    const serviceKey = process.env["SUPABASE_SERVICE_ROLE_KEY"] ?? process.env["SUPABASE_ANON_KEY"] ?? ""
    supabaseAdmin = createClient(url, serviceKey)
  }
  return supabaseAdmin
}

function getAnonClient(url: string, anonKey: string): SupabaseClient {
  if (!supabaseAnon) {
    supabaseAnon = createClient(url, anonKey)
  }
  return supabaseAnon
}

async function ensureBucketExists(adminClient: SupabaseClient): Promise<void> {
  const { data: buckets, error: listError } = await adminClient.storage.listBuckets()
  if (listError) {
    log(`Warning: Could not list buckets: ${listError.message}`)
    return
  }

  const exists = buckets?.some((b) => b.name === BUCKET_NAME) ?? false
  if (!exists) {
    log(`Bucket "${BUCKET_NAME}" not found. Creating...`)
    const { error: createError } = await adminClient.storage.createBucket(BUCKET_NAME, {
      public: true,
      fileSizeLimit: 52428800,
    })
    if (createError) {
      throw new Error(`Failed to create bucket "${BUCKET_NAME}": ${createError.message}`)
    }
    log(`Bucket "${BUCKET_NAME}" created successfully.`)
  }
}

export interface UploadResult {
  fileName: string
  publicUrl: string
  path: string
}

export async function saveDailyReport(
  supabaseUrl: string,
  analysis: import("./claude-analyzer").AnalysisResult,
  runNumber: number,
  memoryStoreId: string
): Promise<void> {
  log("Saving analysis to Supabase daily_reports table...")
  const admin = getAdminClient(supabaseUrl)

  const baseRow = {
    analysis_date: analysis.analysisDate,
    run_number: runNumber,
    youtube_insights: analysis.youtubeInsights,
    github_projects: analysis.githubProjects,
    implementation_guide: analysis.implementationGuide,
    priority_actions: analysis.priorityActions,
    executive_summary: analysis.executiveSummary,
    memory_store_id: memoryStoreId,
  }

  // Novos campos multi-fonte. Requerem as colunas adicionadas pela migration.
  const extendedRow = {
    ...baseRow,
    claude_improvements: analysis.claudeImprovements,
    connectable_apis: analysis.connectableAPIs,
    topic_summaries: analysis.topicSummaries,
  }

  let { error } = await admin.from("daily_reports").insert(extendedRow)

  // Fallback SEM migration: se as colunas novas não existem, embute os extras dentro
  // de implementation_guide (sentinela). O dashboard desembrulha automaticamente.
  // Assim as seções novas funcionam mesmo sem rodar a migration no Supabase.
  if (error && /column|does not exist|schema cache|could not find/i.test(error.message)) {
    log(`Colunas novas ausentes (${error.message}). Usando fallback embutido (sem migration).`)
    const extra = {
      claudeImprovements: analysis.claudeImprovements,
      connectableAPIs: analysis.connectableAPIs,
      topicSummaries: analysis.topicSummaries,
    }
    const embeddedRow = {
      ...baseRow,
      implementation_guide:
        baseRow.implementation_guide +
        `\n\n<!--CAMO_EXTRA_V1:${encodeURIComponent(JSON.stringify(extra))}-->`,
    }
    ;({ error } = await admin.from("daily_reports").insert(embeddedRow))
  }

  if (error) throw new Error(`Failed to save report: ${error.message}`)
  log("Report saved to dashboard database.")
}

/**
 * Uploads a PDF file to Supabase storage and returns the public URL.
 */
export async function uploadPDF(
  supabaseUrl: string,
  supabaseAnonKey: string,
  pdfFilePath: string
): Promise<UploadResult> {
  log(`Uploading PDF: ${pdfFilePath}`)

  if (!fs.existsSync(pdfFilePath)) {
    throw new Error(`PDF file not found: ${pdfFilePath}`)
  }

  const adminClient = getAdminClient(supabaseUrl)
  const anonClient = getAnonClient(supabaseUrl, supabaseAnonKey)
  await ensureBucketExists(adminClient)

  const fileName = path.basename(pdfFilePath)
  const fileBuffer = fs.readFileSync(pdfFilePath)

  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, "0")
  const storagePath = `reports/${year}/${month}/${fileName}`

  log(`Uploading to storage path: ${storagePath}`)

  const { error: uploadError } = await adminClient.storage
    .from(BUCKET_NAME)
    .upload(storagePath, fileBuffer, {
      contentType: "application/pdf",
      upsert: true, // Allow overwrite if re-running same day
    })

  if (uploadError) {
    throw new Error(`Upload failed: ${uploadError.message}`)
  }

  const { data: urlData } = anonClient.storage
    .from(BUCKET_NAME)
    .getPublicUrl(storagePath)

  const publicUrl = urlData.publicUrl

  log(`Upload successful. Public URL: ${publicUrl}`)

  return {
    fileName,
    publicUrl,
    path: storagePath,
  }
}
