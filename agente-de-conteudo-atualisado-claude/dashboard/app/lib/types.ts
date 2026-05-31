export interface DailyReport {
  id: string;
  created_at: string;
  analysis_date: string;
  run_number: number;
  youtube_insights: YouTubeInsight[];
  github_projects: GitHubProjectAnalysis[];
  implementation_guide: string;
  priority_actions: string[];
  executive_summary: string;
  memory_store_id: string;
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
