export interface DailyReport {
  id: string;
  created_at: string;
  analysis_date: string;
  run_number: number;
  youtube_insights: YouTubeInsight[];
  github_projects: GitHubProjectAnalysis[];
  claude_improvements?: ClaudeImprovement[];
  connectable_apis?: ConnectableAPI[];
  topic_summaries?: TopicSummary[];
  implementation_guide: string;
  priority_actions: string[];
  executive_summary: string;
  memory_store_id: string;
}

export interface ImplementationByAgent {
  contentAgent: string;
  instagramDmAgent: string;
  camoSocialAgent: string;
}

export interface ClaudeImprovement {
  title: string;
  category: "feature" | "api" | "sdk" | "model" | "pattern" | "tooling" | "mcp";
  whatItIs: string;
  whatItDoes: string;
  benefits: string[];
  howToImplement: string;
  priority: "high" | "medium" | "low";
  sources: { platform: string; title: string; url: string }[];
  implementationByAgent: ImplementationByAgent;
}

export interface ConnectableAPI {
  name: string;
  whatItIs: string;
  useCase: string;
  howToConnect: string;
  benefits: string[];
  docsUrl?: string;
  appliesTo: string[];
}

export interface TopicSummary {
  platform: "youtube" | "github" | "reddit" | "google" | "linkedin" | "twitter" | "instagram" | "web";
  topic: string;
  summary: string;
  takeaways: string[];
  url?: string;
}

export interface YouTubeInsight {
  videoId: string;
  title: string;
  url: string;
  summary: string;
  fullAnalysis: string;
  keyFeatures: string[];
  visualDemonstrations: string[];
  implementationTips: string[];
  implementationForOurSystem: string;
  improvements: string[];
  priorityLevel: "high" | "medium" | "low";
}

export interface GitHubProjectAnalysis {
  name: string;
  url: string;
  stars: number;
  description: string;
  whatItDoes: string;
  improvements: string[];
  howToImplement: string[];
  implementationForOurSystem: string;
  priority: "high" | "medium" | "low";
  worthImplementing: boolean;
  securityScore?: number;
}

export interface ReportHistoryItem {
  id: string;
  created_at: string;
  analysis_date: string;
  run_number: number;
  executive_summary: string;
}
