import { Resend } from "resend"
import type { AnalysisResult } from "./claude-analyzer"

function log(message: string): void {
  console.log(`[${new Date().toISOString()}] [EmailSender] ${message}`)
}

function buildEmailHtml(
  analysis: AnalysisResult,
  pdfUrl: string,
  reportDate: string
): string {
  const priorityActionsHtml = analysis.priorityActions
    .map(
      (action, i) => `
      <tr>
        <td style="padding: 10px 0; border-bottom: 1px solid #f3f4f6; vertical-align: top;">
          <span style="display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; background: #7c3aed; color: white; border-radius: 50%; font-size: 11px; font-weight: 700; margin-right: 10px;">${i + 1}</span>
          <span style="color: #374151; font-size: 14px;">${action}</span>
        </td>
      </tr>`
    )
    .join("")

  const videoCountText =
    analysis.youtubeInsights.length === 0
      ? "No new videos today"
      : `${analysis.youtubeInsights.length} new video${analysis.youtubeInsights.length === 1 ? "" : "s"} analyzed`

  const githubCountText =
    analysis.githubProjects.length === 0
      ? "No new projects today"
      : `${analysis.githubProjects.length} project${analysis.githubProjects.length === 1 ? "" : "s"} curated`

  const highPriorityProjects = analysis.githubProjects
    .filter((p) => p.priority === "high" && p.worthImplementing)
    .slice(0, 3)

  const highPriorityHtml = highPriorityProjects.length > 0
    ? highPriorityProjects
        .map(
          (p) => `
          <div style="background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 14px 16px; margin-bottom: 10px;">
            <div style="font-weight: 700; color: #065f46; margin-bottom: 4px;">
              &#x2B50; ${p.name}
              <span style="font-weight: 400; color: #16a34a; font-size: 12px; margin-left: 8px;">${p.stars} stars</span>
            </div>
            <div style="color: #374151; font-size: 13px;">${p.whatItDoes}</div>
            <a href="${p.url}" style="color: #7c3aed; font-size: 12px; text-decoration: none; display: block; margin-top: 6px;">View on GitHub &rarr;</a>
          </div>`
        )
        .join("")
    : '<p style="color: #9ca3af; font-size: 13px;">No high-priority projects today.</p>'

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
</head>
<body style="margin: 0; padding: 0; background: #f9fafb; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">

  <div style="max-width: 600px; margin: 0 auto; padding: 24px 16px;">

    <!-- Header -->
    <div style="background: linear-gradient(135deg, #16213e 0%, #0f3460 50%, #533483 100%); border-radius: 12px; padding: 32px; margin-bottom: 24px; text-align: center;">
      <div style="font-size: 11px; text-transform: uppercase; letter-spacing: 3px; color: #a78bfa; margin-bottom: 8px;">Daily Intelligence Report</div>
      <h1 style="color: #ffffff; font-size: 24px; font-weight: 700; margin: 0 0 8px 0;">Claude Code Daily Brief</h1>
      <div style="color: #c4b5fd; font-size: 14px;">${reportDate}</div>
    </div>

    <!-- Stats Row -->
    <div style="display: flex; gap: 12px; margin-bottom: 24px;">
      <div style="flex: 1; background: white; border: 1px solid #e5e7eb; border-radius: 10px; padding: 16px; text-align: center;">
        <div style="font-size: 28px; font-weight: 700; color: #7c3aed;">${analysis.youtubeInsights.length}</div>
        <div style="font-size: 12px; color: #6b7280; margin-top: 4px;">${videoCountText}</div>
      </div>
      <div style="flex: 1; background: white; border: 1px solid #e5e7eb; border-radius: 10px; padding: 16px; text-align: center;">
        <div style="font-size: 28px; font-weight: 700; color: #7c3aed;">${analysis.githubProjects.length}</div>
        <div style="font-size: 12px; color: #6b7280; margin-top: 4px;">${githubCountText}</div>
      </div>
      <div style="flex: 1; background: white; border: 1px solid #e5e7eb; border-radius: 10px; padding: 16px; text-align: center;">
        <div style="font-size: 28px; font-weight: 700; color: #ea580c;">${analysis.priorityActions.length}</div>
        <div style="font-size: 12px; color: #6b7280; margin-top: 4px;">Priority actions</div>
      </div>
    </div>

    <!-- Executive Summary -->
    <div style="background: white; border: 1px solid #e5e7eb; border-left: 4px solid #7c3aed; border-radius: 0 10px 10px 0; padding: 20px; margin-bottom: 24px;">
      <div style="font-size: 11px; text-transform: uppercase; letter-spacing: 2px; color: #7c3aed; margin-bottom: 10px;">Executive Summary</div>
      <p style="color: #374151; font-size: 14px; line-height: 1.7; margin: 0;">${analysis.executiveSummary}</p>
    </div>

    <!-- Priority Actions -->
    <div style="background: white; border: 1px solid #e5e7eb; border-radius: 10px; padding: 20px; margin-bottom: 24px;">
      <div style="font-size: 11px; text-transform: uppercase; letter-spacing: 2px; color: #ea580c; margin-bottom: 14px; font-weight: 700;">&#x26A1; Priority Actions for Today</div>
      <table style="width: 100%; border-collapse: collapse;">
        ${priorityActionsHtml}
      </table>
    </div>

    <!-- High Priority GitHub Projects -->
    <div style="background: white; border: 1px solid #e5e7eb; border-radius: 10px; padding: 20px; margin-bottom: 24px;">
      <div style="font-size: 11px; text-transform: uppercase; letter-spacing: 2px; color: #065f46; margin-bottom: 14px; font-weight: 700;">&#x1F4E6; Top GitHub Projects</div>
      ${highPriorityHtml}
    </div>

    <!-- Download PDF CTA -->
    <div style="text-align: center; margin-bottom: 24px;">
      <a href="${pdfUrl}" style="display: inline-block; background: linear-gradient(135deg, #7c3aed 0%, #4f46e5 100%); color: white; padding: 16px 32px; border-radius: 10px; text-decoration: none; font-weight: 700; font-size: 16px;">
        &#x1F4C4; Download Full PDF Report
      </a>
      <div style="margin-top: 10px; font-size: 12px; color: #9ca3af;">
        Includes full analysis, implementation guide, and all project details
      </div>
    </div>

    <!-- Footer -->
    <div style="text-align: center; color: #9ca3af; font-size: 11px; padding-top: 16px; border-top: 1px solid #e5e7eb;">
      Generated by <strong>Claude Code Daily Intelligence Agent</strong><br />
      Powered by Anthropic Claude &bull; Auto-delivered daily
    </div>

  </div>

</body>
</html>`
}

export async function sendEmailReport(
  resendApiKey: string,
  recipientEmail: string,
  analysis: AnalysisResult,
  pdfUrl: string
): Promise<void> {
  log(`Sending email report to ${recipientEmail}...`)

  const resend = new Resend(resendApiKey)

  const reportDate = new Date(analysis.analysisDate).toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  })

  const subject = `Claude Code Daily Brief — ${reportDate} (${analysis.youtubeInsights.length} videos, ${analysis.githubProjects.length} projects)`

  const html = buildEmailHtml(analysis, pdfUrl, reportDate)

  const plainText = `
Claude Code Daily Intelligence Report
${reportDate}

EXECUTIVE SUMMARY:
${analysis.executiveSummary}

PRIORITY ACTIONS:
${analysis.priorityActions.map((a, i) => `${i + 1}. ${a}`).join("\n")}

YouTube Videos Analyzed: ${analysis.youtubeInsights.length}
GitHub Projects Curated: ${analysis.githubProjects.length}

Full PDF Report: ${pdfUrl}

---
Generated by Claude Code Daily Intelligence Agent
`.trim()

  const { data, error } = await resend.emails.send({
    from: "Claude Code Agent <onboarding@resend.dev>",
    to: [recipientEmail],
    subject,
    html,
    text: plainText,
  })

  if (error) {
    throw new Error(`Email sending failed: ${error.message}`)
  }

  log(`Email sent successfully. ID: ${data?.id ?? "unknown"}`)
}
