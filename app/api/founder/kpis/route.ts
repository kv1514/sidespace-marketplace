import {
  founderErrorResponse,
} from "@/lib/founder/auth";
import {
  getFounderKpis,
  parseFounderKpiPeriod,
} from "@/lib/founder/kpis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const rawDays = new URL(request.url).searchParams.get("days");
  const periodDays = parseFounderKpiPeriod(rawDays);
  if (!periodDays) {
    return Response.json(
      { error: "Choose a KPI period of 7, 30, 90, or 365 days." },
      { status: 400, headers: { "Cache-Control": "private, no-store" } },
    );
  }

  try {
    return Response.json(await getFounderKpis(periodDays), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return founderErrorResponse(error);
  }
}
