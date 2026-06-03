import { getLatestReport, getReportHistory } from "@/app/lib/supabase";
import DashboardClient from "@/app/components/DashboardClient";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function Page() {
  const [latestReport, history] = await Promise.all([
    getLatestReport(),
    getReportHistory(),
  ]);

  return (
    <DashboardClient
      initialReport={latestReport}
      initialHistory={history}
    />
  );
}
