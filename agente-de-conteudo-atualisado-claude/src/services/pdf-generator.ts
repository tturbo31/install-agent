import puppeteer from "puppeteer"
import * as fs from "fs"
import * as path from "path"
import type { AnalysisResult, YouTubeInsight, GitHubProjectAnalysis } from "./claude-analyzer"

function log(message: string): void {
  console.log(`[${new Date().toISOString()}] [PDFGenerator] ${message}`)
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;")
}

/**
 * Converts simple markdown to HTML for the implementation guide section.
 * Handles: ## headers, **bold**, `code`, ```code blocks```, - lists, numbered lists.
 */
function markdownToHtml(markdown: string): string {
  let html = escapeHtml(markdown)

  // Code blocks (must come before inline code)
  html = html.replace(/```[\w]*\n?([\s\S]*?)```/g, (_match, code) => {
    return `<pre><code>${code.trim()}</code></pre>`
  })

  // Inline code
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>")

  // ### Headers
  html = html.replace(/^### (.+)$/gm, "<h3>$1</h3>")
  // ## Headers
  html = html.replace(/^## (.+)$/gm, "<h3>$1</h3>")
  // # Headers
  html = html.replace(/^# (.+)$/gm, "<h3>$1</h3>")

  // Bold
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
  // Italic
  html = html.replace(/\*(.+?)\*/g, "<em>$1</em>")

  // Numbered lists
  html = html.replace(/^\d+\. (.+)$/gm, "<li>$1</li>")

  // Unordered lists
  html = html.replace(/^[-*] (.+)$/gm, "<li>$1</li>")

  // Wrap consecutive <li> elements in <ul>
  html = html.replace(/(<li>[\s\S]*?<\/li>)(\s*<li>[\s\S]*?<\/li>)*/g, (match) => {
    return `<ul>${match}</ul>`
  })

  // Paragraphs — lines with content not already in block tags
  const lines = html.split("\n")
  const processed: string[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) {
      processed.push("")
    } else if (
      trimmed.startsWith("<h") ||
      trimmed.startsWith("<ul") ||
      trimmed.startsWith("<ol") ||
      trimmed.startsWith("<li") ||
      trimmed.startsWith("<pre") ||
      trimmed.startsWith("</")
    ) {
      processed.push(trimmed)
    } else {
      processed.push(`<p>${trimmed}</p>`)
    }
  }

  return processed.join("\n")
}

function buildVideoCard(insight: YouTubeInsight): string {
  const keyFeatureTags = insight.keyFeatures
    .slice(0, 8)
    .map((f) => `<span class="tag feature">${escapeHtml(f)}</span>`)
    .join("")

  const visualTags = insight.visualDemonstrations
    .slice(0, 6)
    .map((v) => `<span class="tag visual">${escapeHtml(v)}</span>`)
    .join("")

  const tipTags = insight.implementationTips
    .slice(0, 5)
    .map((t) => `<span class="tag tip">${escapeHtml(t)}</span>`)
    .join("")

  return `
    <div class="video-card">
      <div class="video-card-header">
        <h3>${escapeHtml(insight.title)}</h3>
        <a class="video-url" href="${escapeHtml(insight.url)}">${escapeHtml(insight.url)}</a>
      </div>
      <div class="video-card-body">
        <div class="video-summary">${escapeHtml(insight.summary)}</div>

        ${keyFeatureTags ? `
        <div class="video-subsection">
          <h4>Key Features Demonstrated</h4>
          <div class="tag-list">${keyFeatureTags}</div>
        </div>` : ""}

        ${visualTags ? `
        <div class="video-subsection">
          <h4>Visual Demonstrations</h4>
          <div class="tag-list">${visualTags}</div>
        </div>` : ""}

        ${tipTags ? `
        <div class="video-subsection">
          <h4>Implementation Tips</h4>
          <div class="tag-list">${tipTags}</div>
        </div>` : ""}
      </div>
    </div>`
}

function buildGitHubCard(project: GitHubProjectAnalysis): string {
  const improvementsList = project.improvements
    .slice(0, 4)
    .map((i) => `<li>${escapeHtml(i)}</li>`)
    .join("")

  const implementList = project.howToImplement
    .slice(0, 4)
    .map((s) => `<li>${escapeHtml(s)}</li>`)
    .join("")

  const priorityClass = `priority-${project.priority}`

  return `
    <div class="github-card">
      <div class="github-card-header ${priorityClass}">
        <span class="repo-name">${escapeHtml(project.name)}</span>
        <span class="stars-badge">&#x2605; ${project.stars.toLocaleString()}</span>
        <span class="priority-badge ${project.priority}">${escapeHtml(project.priority)}</span>
        ${project.worthImplementing ? '<span class="priority-badge high">Worth Implementing</span>' : ""}
      </div>
      <div class="github-card-body">
        <div class="repo-description">${escapeHtml(project.description)}</div>
        <div class="repo-what">${escapeHtml(project.whatItDoes)}</div>

        <div class="two-col">
          ${improvementsList ? `
          <div class="mini-list">
            <h4>What It Improves</h4>
            <ul>${improvementsList}</ul>
          </div>` : "<div></div>"}

          ${implementList ? `
          <div class="mini-list">
            <h4>How to Implement</h4>
            <ul>${implementList}</ul>
          </div>` : "<div></div>"}
        </div>

        <div class="repo-meta">
          <span class="meta-item">${escapeHtml(project.url)}</span>
        </div>
      </div>
    </div>`
}

function buildYouTubeSection(insights: YouTubeInsight[]): string {
  if (insights.length === 0) {
    return `
      <div class="empty-state">
        <div class="empty-state-icon">&#x1F4FA;</div>
        <div>No new videos published in the last 24 hours.</div>
      </div>`
  }
  return insights.map(buildVideoCard).join("\n")
}

function buildGitHubSection(projects: GitHubProjectAnalysis[]): string {
  if (projects.length === 0) {
    return `
      <div class="empty-state">
        <div class="empty-state-icon">&#x1F4E6;</div>
        <div>No new GitHub projects found matching criteria in the last 7 days.</div>
      </div>`
  }
  return projects.map(buildGitHubCard).join("\n")
}

function buildPriorityActions(actions: string[]): string {
  return actions.map((action) => `<li>${escapeHtml(action)}</li>`).join("\n")
}

export async function generatePDF(
  analysis: AnalysisResult,
  outputDir: string = "./reports"
): Promise<string> {
  log("Starting PDF generation...")

  // Ensure output directory exists
  fs.mkdirSync(outputDir, { recursive: true })

  // Load HTML template
  const templatePath = path.resolve(__dirname, "../../templates/report.html")
  if (!fs.existsSync(templatePath)) {
    throw new Error(`Template not found at: ${templatePath}`)
  }
  let html = fs.readFileSync(templatePath, "utf-8")

  // Format dates
  const reportDate = new Date(analysis.analysisDate)
  const dateStr = reportDate.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  })
  const timeStr = reportDate.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  })

  // Replace template placeholders
  html = html.replace("{{DATE}}", dateStr)
  html = html.replace("{{FULL_DATE}}", `${dateStr} at ${timeStr}`)
  html = html.replace("{{GENERATED_AT}}", timeStr)
  html = html.replace(/{{VIDEO_COUNT}}/g, String(analysis.youtubeInsights.length))
  html = html.replace(/{{GITHUB_COUNT}}/g, String(analysis.githubProjects.length))
  html = html.replace("{{ACTION_COUNT}}", String(analysis.priorityActions.length))
  html = html.replace("{{EXECUTIVE_SUMMARY}}", escapeHtml(analysis.executiveSummary))
  html = html.replace("{{PRIORITY_ACTIONS}}", buildPriorityActions(analysis.priorityActions))
  html = html.replace("{{YOUTUBE_SECTION}}", buildYouTubeSection(analysis.youtubeInsights))
  html = html.replace("{{GITHUB_SECTION}}", buildGitHubSection(analysis.githubProjects))
  html = html.replace("{{IMPLEMENTATION_GUIDE}}", markdownToHtml(analysis.implementationGuide))

  // Launch puppeteer
  log("Launching Puppeteer...")
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--font-render-hinting=none",
    ],
  })

  try {
    const page = await browser.newPage()
    await page.setContent(html, { waitUntil: "networkidle0" })

    // Generate filename with date
    const dateSlug = reportDate.toISOString().split("T")[0]
    const fileName = `claude-code-report-${dateSlug}.pdf`
    const filePath = path.resolve(outputDir, fileName)

    await page.pdf({
      path: filePath,
      format: "A4",
      printBackground: true,
      margin: {
        top: "0",
        bottom: "0",
        left: "0",
        right: "0",
      },
    })

    log(`PDF generated: ${filePath}`)
    return filePath
  } finally {
    await browser.close()
  }
}
