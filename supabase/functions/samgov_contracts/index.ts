// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json"
};
function toMmDdYyyy(d) {
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${mm}/${dd}/${yyyy}`;
}
function toIsoOrNull(x) {
  if (typeof x !== "string" || !x) return null;
  const d = new Date(x);
  return isNaN(d.getTime()) ? null : d.toISOString();
}
serve(async (req)=>{
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: CORS
    });
  }
  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const SAM_API_KEY = Deno.env.get("SAM_API_KEY"); // Required
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return new Response(JSON.stringify({
        error: "Server not configured."
      }), {
        status: 500,
        headers: CORS
      });
    }
    if (!SAM_API_KEY) {
      return new Response(JSON.stringify({
        error: "Missing SAM_API_KEY."
      }), {
        status: 500,
        headers: CORS
      });
    }
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const body = await req.json().catch(()=>({}));
    // Defaults: last 30 days if not provided
    const now = new Date();
    const from = body.postedFrom ? new Date(body.postedFrom) : new Date(now.getTime() - 29 * 86400_000);
    const to = body.postedTo ? new Date(body.postedTo) : now;
    const limit = Math.min(Math.max(Number(body.limit ?? 50), 1), 1000);
    const offset = Math.max(Number(body.offset ?? 0), 0);
    // Build query params per official v2 docs
    // Endpoint per docs: https://api.sam.gov/opportunities/v2/search  (v2)
    const api = new URL("https://api.sam.gov/opportunities/v2/search");
    api.searchParams.set("api_key", SAM_API_KEY);
    api.searchParams.set("postedFrom", toMmDdYyyy(from));
    api.searchParams.set("postedTo", toMmDdYyyy(to));
    api.searchParams.set("limit", String(limit));
    api.searchParams.set("offset", String(offset));
    if (body.keywords && body.keywords.trim()) api.searchParams.set("title", body.keywords.trim());
    if (body.naics && body.naics.trim()) api.searchParams.set("ncode", body.naics.trim());
    if (body.state && body.state.trim()) api.searchParams.set("state", body.state.trim());
    const resp = await fetch(api.toString(), {
      method: "GET",
      headers: {
        "Accept": "application/json"
      }
    });
    if (!resp.ok) {
      const text = await resp.text();
      return new Response(JSON.stringify({
        error: `SAM.gov error ${resp.status}`,
        detail: text
      }), {
        status: resp.status,
        headers: CORS
      });
    }
    const json = await resp.json();
    const total = Number(json?.totalRecords ?? 0);
    const rows = Array.isArray(json?.opportunitiesData) ? json.opportunitiesData : [];
    const items = rows.map((r)=>{
      const city = r?.placeOfPerformance?.city?.name ?? null;
      const state = r?.placeOfPerformance?.state?.code ?? null;
      const country = r?.placeOfPerformance?.country?.code ?? null;
      // Attachment links (if present)
      const attachments = Array.isArray(r?.resourceLinks) ? r.resourceLinks.map((u, i)=>({
          name: `Attachment ${i + 1}`,
          url: u || null
        })) : [];
      // UI link (may be null in some results)
      const samNotice = typeof r?.uiLink === "string" && r.uiLink?.trim()?.length ? r.uiLink.trim() : null;
      // Preferred agency text
      const agency = r?.fullParentPathName || r?.department || null;
      return {
        noticeId: r?.noticeId ?? null,
        title: r?.title ?? null,
        agency,
        naics: r?.naicsCode ?? null,
        setAside: r?.typeOfSetAsideDescription ?? r?.typeOfSetAside ?? null,
        type: r?.type ?? null,
        solicitationNumber: r?.solicitationNumber ?? null,
        placeOfPerformance: {
          city,
          state,
          country
        },
        dates: {
          posted: r?.postedDate ?? null,
          responseDue: r?.responseDeadLine ?? null
        },
        urls: {
          samNotice,
          attachments 
        },
        raw: r
      };
    });
    // Upsert into DB (idempotent by notice_id)
    if (items.length) {
      const upsertPayload = items.filter((i)=>i.noticeId).map((i)=>({
          notice_id: i.noticeId,
          title: i.title,
          agency: i.agency,
          naics: i.naics,
          set_aside: i.setAside,
          notice_type: i.type,
          solicitation_number: i.solicitationNumber,
          place_city: i.placeOfPerformance.city,
          place_state: i.placeOfPerformance.state,
          place_country: i.placeOfPerformance.country,
          posted_at: toIsoOrNull(i.dates.posted),
          response_due_at: toIsoOrNull(i.dates.responseDue),
          sam_ui_link: i.urls.samNotice,
          attachments: i.urls.attachments ?? [],
          raw: i.raw ?? null,
          updated_at: new Date().toISOString()
        }));
      const { error: dbError } = await supabase.from("samgov_contracts").upsert(upsertPayload, {
        onConflict: "notice_id"
      });
      if (dbError) {
        return new Response(JSON.stringify({
          error: "DB upsert failed",
          detail: dbError.message
        }), {
          status: 500,
          headers: CORS
        });
      }
    }
    const payload = {
      total,
      items
    };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: CORS
    });
  } catch (err) {
    return new Response(JSON.stringify({
      error: "Unhandled error",
      detail: String(err?.message || err)
    }), {
      status: 500,
      headers: CORS
    });
  }
});
