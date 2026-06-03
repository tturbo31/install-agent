import { exec } from "child_process"
import { promisify } from "util"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import sharp from "sharp"

const execAsync = promisify(exec)

export interface VideoFrame {
  timestamp: number // seconds
  imageBuffer: Buffer
  base64: string
}

function log(message: string): void {
  console.log(`[${new Date().toISOString()}] [VideoProcessor] ${message}`)
}

/**
 * Downloads a YouTube video using yt-dlp and extracts frames every intervalSeconds.
 * Returns an empty array if yt-dlp is not available or download fails.
 */
export async function extractVideoFrames(
  videoUrl: string,
  intervalSeconds: number = 30
): Promise<VideoFrame[]> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-agent-video-"))
  const videoPath = path.join(tmpDir, "video.mp4")
  const framesDir = path.join(tmpDir, "frames")
  fs.mkdirSync(framesDir, { recursive: true })

  try {
    // Check yt-dlp availability
    await execAsync("yt-dlp --version")
    log(`Downloading video: ${videoUrl}`)

    // Download video (max 720p to save bandwidth, limit to 15 min)
    await execAsync(
      `yt-dlp -f "bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720][ext=mp4]/best[height<=720]" ` +
        `--merge-output-format mp4 ` +
        `--match-filter "duration <= 900" ` +
        `-o "${videoPath}" ` +
        `"${videoUrl}"`,
      { timeout: 300_000 } // 5 min timeout
    )

    if (!fs.existsSync(videoPath)) {
      log("Video download produced no file (possibly filtered out by duration). Skipping frames.")
      return []
    }

    log(`Video downloaded. Extracting frames every ${intervalSeconds}s...`)

    // Use ffmpeg (bundled with yt-dlp often, or separate) to extract frames
    const framePattern = path.join(framesDir, "frame_%04d.jpg")
    await execAsync(
      `ffmpeg -i "${videoPath}" -vf "fps=1/${intervalSeconds},scale=1280:-2" -q:v 3 "${framePattern}"`,
      { timeout: 120_000 }
    )

    // Read and process frames with sharp (resize to reduce token cost)
    const frameFiles = fs
      .readdirSync(framesDir)
      .filter((f) => f.startsWith("frame_") && f.endsWith(".jpg"))
      .sort()

    log(`Extracted ${frameFiles.length} raw frames. Processing...`)

    const frames: VideoFrame[] = []
    for (let i = 0; i < frameFiles.length; i++) {
      const framePath = path.join(framesDir, frameFiles[i])
      // Resize to 800px wide for Claude Vision (keeps cost reasonable)
      const processed = await sharp(framePath)
        .resize({ width: 800, withoutEnlargement: true })
        .jpeg({ quality: 75 })
        .toBuffer()

      const timestamp = (i + 1) * intervalSeconds
      frames.push({
        timestamp,
        imageBuffer: processed,
        base64: processed.toString("base64"),
      })
    }

    log(`Processed ${frames.length} frames successfully.`)
    return frames
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err)
    if (errorMessage.includes("yt-dlp: not found") || errorMessage.includes("'yt-dlp' is not recognized")) {
      log("yt-dlp not available. Falling back to transcript-only analysis.")
    } else if (errorMessage.includes("ffmpeg")) {
      log("ffmpeg not available. Falling back to transcript-only analysis.")
    } else {
      log(`Frame extraction failed: ${errorMessage.slice(0, 200)}`)
    }
    return []
  } finally {
    // Cleanup temp directory
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      // Non-critical cleanup failure
    }
  }
}

/**
 * Formats frames for the Claude Vision API messages array.
 * Claude accepts up to ~20 images per message comfortably.
 */
export function framesToClaudeContent(
  frames: VideoFrame[]
): Array<{ type: "image"; source: { type: "base64"; media_type: "image/jpeg"; data: string } }> {
  // Limit to max 20 frames to keep token usage reasonable
  const sampled = frames.length > 20
    ? frames.filter((_, i) => i % Math.ceil(frames.length / 20) === 0).slice(0, 20)
    : frames

  return sampled.map((frame) => ({
    type: "image" as const,
    source: {
      type: "base64" as const,
      media_type: "image/jpeg" as const,
      data: frame.base64,
    },
  }))
}
