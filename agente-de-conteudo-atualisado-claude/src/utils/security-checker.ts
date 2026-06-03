export interface SecurityCheckResult {
  score: number // 0-100, 100 = fully safe
  passed: boolean
  flags: string[]
}

// Known suspicious domains often used in malicious scripts
const SUSPICIOUS_DOMAINS = [
  "bit.ly",
  "tinyurl.com",
  "t.co",
  "goo.gl",
  "ow.ly",
  "pastebin.com",
  "raw.githubusercontent.com/unknown",
  "iplogger.org",
  "grabify.link",
]

// Patterns that indicate potentially malicious code
const MALICIOUS_PATTERNS = [
  {
    pattern: /eval\s*\(\s*(?:atob|Buffer\.from|require\s*\(\s*['"]child_process)/gi,
    label: "eval() with obfuscated/remote code execution",
    weight: 40,
  },
  {
    pattern: /process\.env\s*\.\s*\w+\s*=\s*['"][^'"]{20,}/gi,
    label: "Runtime env var injection",
    weight: 20,
  },
  {
    pattern: /require\s*\(\s*['"]child_process['"]\s*\)[\s\S]{0,200}exec\s*\(/gi,
    label: "child_process exec call",
    weight: 15,
  },
  {
    pattern: /(?:crypto|miner|monero|xmr|coinhive|coin-hive|cryptonight)/gi,
    label: "Crypto miner keywords",
    weight: 35,
  },
  {
    pattern: /(?:\/\/|#)\s*(?:obfuscated|do not read|encrypted payload|encoded)/gi,
    label: "Obfuscation hints in comments",
    weight: 25,
  },
  {
    pattern: /fetch\s*\(\s*['"](?:https?:\/\/(?!api\.github\.com|api\.anthropic\.com|registry\.npmjs\.org))[^'"]{1,20}['"]/gi,
    label: "Fetch to uncommon external URL",
    weight: 10,
  },
  {
    pattern: /(?:rm\s+-rf|rmdir\s+\/s|del\s+\/f\s+\/s\s+\/q)\s+[~/\\]/gi,
    label: "Destructive filesystem command",
    weight: 50,
  },
  {
    pattern: /(?:base64|btoa|atob)\s*\([^)]{50,}/gi,
    label: "Long base64 encoded payload",
    weight: 20,
  },
  {
    pattern: /postinstall.*(?:curl|wget|powershell|bash|sh)\s+/gi,
    label: "postinstall script with shell download",
    weight: 45,
  },
  {
    pattern: /(?:ssh|scp|rsync)\s+[^;]{0,100}@[^;]{0,50}:/gi,
    label: "SSH/SCP command with remote host",
    weight: 30,
  },
]

// Package.json specific checks
const PACKAGE_JSON_RISKS = [
  {
    pattern: /"(?:preinstall|postinstall|prepare)"\s*:\s*"[^"]*(?:curl|wget|bash|sh|powershell|cmd)[^"]*"/gi,
    label: "Dangerous lifecycle script",
    weight: 40,
  },
  {
    pattern: /"scripts"\s*:\s*\{[^}]*(?:rm\s+-rf|del\s+\/f)/gi,
    label: "Destructive command in scripts",
    weight: 50,
  },
]

function checkSuspiciousDomains(content: string): string[] {
  const flags: string[] = []
  for (const domain of SUSPICIOUS_DOMAINS) {
    if (content.toLowerCase().includes(domain)) {
      flags.push(`References suspicious domain: ${domain}`)
    }
  }
  return flags
}

export function checkSecurity(
  readme: string,
  packageJsonContent: string | null
): SecurityCheckResult {
  const flags: string[] = []
  let deduction = 0

  // Check README for malicious patterns
  for (const { pattern, label, weight } of MALICIOUS_PATTERNS) {
    if (pattern.test(readme)) {
      flags.push(`README: ${label}`)
      deduction += weight
    }
  }

  // Check package.json if available
  if (packageJsonContent) {
    for (const { pattern, label, weight } of PACKAGE_JSON_RISKS) {
      if (pattern.test(packageJsonContent)) {
        flags.push(`package.json: ${label}`)
        deduction += weight
      }
    }
    for (const { pattern, label, weight } of MALICIOUS_PATTERNS) {
      if (pattern.test(packageJsonContent)) {
        flags.push(`package.json: ${label}`)
        deduction += weight
      }
    }
  }

  // Check for suspicious domains in all content
  const combinedContent = readme + (packageJsonContent ?? "")
  const domainFlags = checkSuspiciousDomains(combinedContent)
  for (const flag of domainFlags) {
    flags.push(flag)
    deduction += 10
  }

  const score = Math.max(0, 100 - deduction)
  const passed = score >= 50 && !flags.some((f) => f.includes("Destructive") || f.includes("crypto miner"))

  return { score, passed, flags }
}
