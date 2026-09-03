import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks=vi.hoisted(()=>({rpc:vi.fn()}));
vi.mock("../lib/supabase/admin",()=>({createAdminClient:()=>({rpc:mocks.rpc})}));
import { POST } from "../app/api/listings/quote/route";
const body={listingId:"83000000-0000-4000-8000-000000000001",startDate:"2026-09-10",endDate:"2026-09-19",listingUpdatedAt:"2026-09-03T12:00:00Z"};
const request=(value:unknown)=>new Request("http://localhost:3000/api/listings/quote",{method:"POST",body:JSON.stringify(value)});
beforeEach(()=>vi.clearAllMocks());
describe("read-only booking quote route",()=>{
 it("uses the database subtotal, ignoring client price and identity",async()=>{
  mocks.rpc.mockResolvedValue({data:{timingKind:"date_range",startDate:body.startDate,endDate:body.endDate,days:10,subtotalCents:10000},error:null});
  const response=await POST(request({...body,priceCents:1,buyerProfileId:"forged"}));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({subtotalCents:10000,buyerFeeCents:500,customerTotalCents:10500});
  expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("quote_listing_booking",{target_listing_id:body.listingId,booking_date:body.startDate,booking_end_date:body.endDate,expected_updated_at:body.listingUpdatedAt});
 });
 it("rejects invalid calendar days before reaching the database",async()=>{
  expect((await POST(request({...body,startDate:"2026-02-30"}))).status).toBe(400);
  expect(mocks.rpc).not.toHaveBeenCalled();
 });
 it("explains the payment minimum without increasing the quoted price",async()=>{
  mocks.rpc.mockResolvedValue({data:{subtotalCents:47},error:null});
  const response=await POST(request(body));
  expect(response.status).toBe(400);
  expect((await response.json()).error).toContain("$0.50 payment minimum");
  mocks.rpc.mockResolvedValue({data:{subtotalCents:48},error:null});
  expect(await (await POST(request(body))).json()).toMatchObject({subtotalCents:48,customerTotalCents:50});
 });
 it("returns a conflict for stale or unavailable terms",async()=>{
  mocks.rpc.mockResolvedValue({data:null,error:{message:"This listing changed. Review the latest terms."}});
  expect((await POST(request(body))).status).toBe(409);
 });
});
