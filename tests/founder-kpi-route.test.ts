import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getFounderKpis: vi.fn(),
}));

vi.mock("@/lib/founder/auth", () => ({
  founderErrorResponse: () =>
    Response.json(
      { error: "Founder KPI data is temporarily unavailable." },
      { status: 503 },
    ),
}));

vi.mock("@/lib/founder/kpis", () => ({
  getFounderKpis: mocks.getFounderKpis,
  parseFounderKpiPeriod: (raw: string | null) => {
    if (!raw) return 30;
    const days = Number(raw);
    return [7, 30, 90, 365].includes(days) ? days : null;
  },
}));

import { GET } from "@/app/api/founder/kpis/route";

describe("founder KPI route", () => {
  beforeEach(() => {
    mocks.getFounderKpis.mockReset();
    mocks.getFounderKpis.mockResolvedValue({
      period: { days: 90 },
      snapshot: {},
      period_metrics: {},
      breakdowns: {},
      daily: [],
    });
  });

  it("defaults to the 30-day window", async () => {
    const response = await GET(new Request("http://localhost/api/founder/kpis"));

    expect(response.status).toBe(200);
    expect(mocks.getFounderKpis).toHaveBeenCalledWith(30);
  });

  it("only accepts supported KPI windows", async () => {
    const response = await GET(
      new Request("http://localhost/api/founder/kpis?days=14"),
    );

    expect(response.status).toBe(400);
    expect(mocks.getFounderKpis).not.toHaveBeenCalled();
  });

  it("passes a supported window through to the server KPI reader", async () => {
    const response = await GET(
      new Request("http://localhost/api/founder/kpis?days=90"),
    );

    expect(response.status).toBe(200);
    expect(mocks.getFounderKpis).toHaveBeenCalledWith(90);
  });

  it("does not expose an internal reader failure", async () => {
    mocks.getFounderKpis.mockRejectedValue(new Error("database details"));

    const response = await GET(
      new Request("http://localhost/api/founder/kpis?days=7"),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Founder KPI data is temporarily unavailable.",
    });
  });
});
