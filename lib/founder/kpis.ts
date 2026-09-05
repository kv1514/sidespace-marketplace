import "server-only";

import { founderErrorResponse, requireFounder } from "@/lib/founder/auth";

export const FOUNDER_KPI_PERIODS = [7, 30, 90, 365] as const;
export type FounderKpiPeriod = (typeof FOUNDER_KPI_PERIODS)[number];

export type FounderKpiPayload = {
  generated_at: string;
  period: {
    days: number;
    start: string;
    end: string;
    timezone: string;
  };
  tracking: {
    event_tracking_started_at: string | null;
    acceptance_events_started_at: string | null;
    legacy_acceptance_dates_available: boolean;
  };
  snapshot: Record<string, number>;
  period_metrics: Record<string, number>;
  breakdowns: {
    request_statuses: Record<string, number>;
    payment_statuses: Record<string, number>;
    active_listing_channels: Record<string, number>;
  };
  daily: Array<{
    date: string;
    listing_views: number;
    new_members: number;
    requests_sent: number;
    campaigns_accepted: number;
    paid_campaigns: number;
    campaigns_fulfilled: number;
    gmv_cents: number;
    platform_gross_revenue_cents: number;
  }>;
};

export function parseFounderKpiPeriod(raw: string | null | undefined): FounderKpiPeriod | null {
  if (!raw) return 30;
  const days = Number(raw);
  return FOUNDER_KPI_PERIODS.includes(days as FounderKpiPeriod)
    ? (days as FounderKpiPeriod)
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export async function getFounderKpis(periodDays: FounderKpiPeriod) {
  const { admin } = await requireFounder();
  const { data, error } = await admin.rpc("get_sidespace_founder_kpis", {
    period_days: periodDays,
  });
  if (error) throw error;
  if (!isRecord(data)) {
    throw new Error("The founder KPI report returned an invalid payload.");
  }
  return data as unknown as FounderKpiPayload;
}

export { founderErrorResponse };
