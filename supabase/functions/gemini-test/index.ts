// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { GoogleGenerativeAI } from "npm:@google/generative-ai@0.21.0";
import Ajv from "npm:ajv@8.17.1";
import { createClient } from "npm:@supabase/supabase-js@2";

/* ==========================
   CONFIG / CONSTANTS
========================== */
const VERSION = "ai-orchestrator:v1.0";
const MODEL = "gemini-2.5-flash";
const PRIVATE_BUCKET = false; // set true if your 'contract_docs' bucket is private

// CORS
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, apikey, x-client-request-id, content-type, x-idempotency-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS },
  });
}

// DB (service role, server-side only)
function makeDb() {
  const url = Deno.env.get("SUPABASE_URL")!;
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  return createClient(url, key, { auth: { persistSession: false } });
}
async function logInsert(row: Record<string, unknown>) {
  try {
    const db = makeDb();
    await db.from("ai_logs").insert(row as any);
  } catch {
    console.error("ai_logs insert failed");
  }
}

// Helpers
const ajv = new Ajv({ allErrors: true, strict: false });
function toBase64(bytes: Uint8Array) {
  // chunked to avoid call stack overflow on large files
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/* ==========================
   SCHEMAS
========================== */
const ExtractOutSchema = {
  type: "object",
  properties: {
    solicitationNumber: { type: "string" },
    title: { type: "string" },
    agency: { type: "string", nullable: true },
    naics: { type: "string", nullable: true },
    psc: { type: "string", nullable: true },
    setAside: { type: "string", nullable: true },
    dueDates: {
      type: "object",
      properties: {
        questions: { type: "string", nullable: true },
        offers: { type: "string", nullable: true },
      },
      additionalProperties: false,
    },
    placeOfPerformance: {
      type: "object",
      properties: {
        city: { type: "string", nullable: true },
        state: { type: "string", nullable: true },
      },
      additionalProperties: false,
      nullable: true,
    },
    tradePackages: {
      type: "array",
      items: {
        type: "object",
        properties: {
          trade: { type: "string" },
          scopeSummary: { type: "string", nullable: true },
        },
        required: ["trade"],
        additionalProperties: false,
      },
      nullable: true,
    },
    attachments: {
      type: "array",
      items: {
        type: "object",
        properties: { filename: { type: "string" } },
        required: ["filename"],
        additionalProperties: false,
      },
      nullable: true,
    },
    citations: {
      type: "array",
      items: {
        type: "object",
        properties: { field: { type: "string" }, ref: { type: "string" } },
        required: ["field", "ref"],
        additionalProperties: false,
      },
      nullable: true,
    },
  },
  required: ["solicitationNumber", "title"],
  additionalProperties: false,
} as const;
const validateExtractOut = ajv.compile(ExtractOutSchema);

const SearchContractsSchema = {
  type: "object",
  properties: {
    query: { type: "string", minLength: 1 },
    state: { type: "string", nullable: true },
    naics: { type: "string", nullable: true },
  },
  required: ["query"],
  additionalProperties: false,
} as const;
const validateSearch = ajv.compile(SearchContractsSchema);

const SummarySchema = {
  type: "object",
  properties: {
    overview: { type: "string" },
    key_dates: {
      type: "object",
      properties: {
        questions_due: { type: "string", nullable: true },
        bids_due: { type: "string", nullable: true },
      },
      additionalProperties: false,
    },
    scope_summary: { type: "string" },
    risk_notes: { type: "array", items: { type: "string" } },
    referenced_files: { type: "array", items: { type: "string" } },
  },
  required: ["overview", "scope_summary"],
  additionalProperties: false,
} as const;
const validateSummary = ajv.compile(SummarySchema);

const JudgeSchema = {
  type: "object",
  properties: {
    prime_contractor_requirements: { type: "array", items: { type: "string" } },
    subcontractor_packages: {
      type: "array",
      items: {
        type: "object",
        properties: {
          trade: { type: "string" },
          scope_items: { type: "array", items: { type: "string" } },
        },
        required: ["trade"],
        additionalProperties: false,
      },
    },
    confidence: { type: "number" },
    rationale: { type: "string" },
  },
  required: ["prime_contractor_requirements", "subcontractor_packages", "confidence"],
  additionalProperties: false,
} as const;
const validateJudge = ajv.compile(JudgeSchema);

/* ==========================
   TOOL DECLARATIONS
========================== */
const functionDeclarations = [
  {
    name: "searchContracts",
    description: "Mocked search over contracts (no DB yet).",
    parameters: {
      type: "OBJECT",
      properties: {
        query: { type: "STRING" },
        state: { type: "STRING", nullable: true },
        naics: { type: "STRING", nullable: true },
      },
      required: ["query"],
    },
  },
  {
    name: "extractSolicitation",
    description: "Extract structured fields from raw solicitation text. Return strictly valid JSON (no prose).",
    parameters: {
      type: "OBJECT",
      properties: {
        text: { type: "STRING" },
        wantSubPackages: { type: "BOOLEAN", nullable: true },
      },
      required: ["text"],
    },
  },
  {
    name: "listContractDocs",
    description: "List PDFs for a given SAM.gov notice id plus any user-uploaded docs for that contract.",
    parameters: {
      type: "OBJECT",
      properties: { noticeId: { type: "STRING" } },
      required: ["noticeId"],
    },
  },
  {
    name: "summarizeDocs",
    description: "Summarize selected PDFs and contract description into a structured JSON summary.",
    parameters: {
      type: "OBJECT",
      properties: {
        noticeId: { type: "STRING" },
        selected: { type: "ARRAY", items: { type: "STRING" } },
        contractDescription: { type: "STRING", nullable: true },
      },
      required: ["noticeId", "selected"],
    },
  },
  {
    name: "judgeBundle",
    description: "Classify summary into prime vs subcontractor needs; return confidence and rationale.",
    parameters: {
      type: "OBJECT",
      properties: { analysisId: { type: "STRING" } },
      required: ["analysisId"],
    },
  },
] as const;

/* ==========================
   TOOLS IMPLEMENTATION
========================== */
type ToolCtx = { idempotencyKey?: string; genAI: GoogleGenerativeAI };
type ToolHandler = (args: any, ctx: ToolCtx) => Promise<any>;

const TOOL_MAP: Record<string, ToolHandler> = {
  // ---- demo search (kept for completeness)
  async searchContracts(args, ctx) {
    if (!validateSearch(args)) {
      const details = validateSearch.errors?.map((e) => `${e.instancePath || "(root)"} ${e.message}`).join("; ");
      const err: any = new Error(`Invalid searchContracts args: ${details}`);
      err.status = 422;
      err.details = validateSearch.errors;
      throw err;
    }
    const { query, state, naics } = args ?? {};
    return {
      idempotencyKey: ctx.idempotencyKey,
      results: [
        {
          id: "demo-123",
          title: `Demo contract for "${query}"`,
          state: state ?? "UT",
          naics: naics ?? "238990",
          url: "https://example.com/demo-contract",
        },
      ],
      count: 1,
    };
  },

  // ---- extraction
  async extractSolicitation(args, ctx) {
    const { text } = args ?? {};
    if (typeof text !== "string" || !text.trim()) {
      const err: any = new Error("extractSolicitation requires { text: string }");
      err.status = 422;
      throw err;
    }
    const model = ctx.genAI.getGenerativeModel({
      model: MODEL,
      systemInstruction: { parts: [{ text: SYSTEM_EXTRACT }] },
    });

    const first = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: text.slice(0, 30000) }] }],
    });

    const tryParse = (s: string) => {
      const cleaned = s.trim().replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
      return JSON.parse(cleaned);
    };

    let raw = first.response.text();
    let parsed: any;
    try {
      parsed = tryParse(raw);
    } catch {
      parsed = null;
    }

    const validate = (obj: any) => (validateExtractOut(obj) ? null : validateExtractOut.errors);
    let errors = parsed ? validate(parsed) : [{ message: "not JSON" } as any];

    if (errors) {
      const repair = `
Your previous JSON did not validate. AJV errors:
${JSON.stringify(errors, null, 2)}
Return corrected JSON ONLY (no prose). Schema again:
${JSON.stringify(ExtractOutSchema)}
Original text:
${text.slice(0, 30000)}
`;
      const second = await model.generateContent({
        contents: [{ role: "user", parts: [{ text: repair }] }],
      });
      raw = second.response.text();
      try {
        parsed = tryParse(raw);
      } catch {
        parsed = null;
      }
      errors = parsed ? validate(parsed) : [{ message: "repair not JSON" } as any];
    }

    if (errors) {
      const err: any = new Error("extractSolicitation: JSON still invalid after repair");
      err.status = 422;
      err.details = errors;
      err.raw = raw;
      throw err;
    }
    return { idempotencyKey: ctx.idempotencyKey, data: parsed };
  },

  // ---- list PDFs for a notice
  async listContractDocs(args, _ctx) {
    const noticeId = String(args?.noticeId || "");
    if (!noticeId) {
      const e: any = new Error("noticeId required");
      e.status = 400;
      throw e;
    }

    const db = makeDb();
    const { data: row, error } = await db
      .from("samgov_contracts")
      .select("notice_id, title, sam_ui_link, attachments")
      .eq("notice_id", noticeId)
      .maybeSingle();
    if (error) throw new Error(error.message);

    const uploadPrefix = `contract_docs/${noticeId}/`;
    const { data: files, error: fErr } = await db.storage.from("contract_docs").list(uploadPrefix, { limit: 100 });
    const uploads = fErr
      ? []
      : (files || [])
          .filter((f) => f.name.toLowerCase().endsWith(".pdf"))
          .map((f) => ({ name: f.name, path: uploadPrefix + f.name }));

    return {
      noticeId,
      title: row?.title ?? null,
      samNoticeUrl: row?.sam_ui_link ?? null,
      attachments: row?.attachments ?? [], // array of URLs from your ingest
      uploads,
    };
  },

  // ---- summarize selected PDFs (+ optional contract description)
  async summarizeDocs(args, ctx) {
    const noticeId = String(args?.noticeId || "");
    const selected: string[] = Array.isArray(args?.selected) ? args.selected : [];
    const contractDescription: string = args?.contractDescription || "";

    if (!noticeId || !selected.length) {
      const e: any = new Error("noticeId and selected[] required");
      e.status = 400;
      throw e;
    }

    const db = makeDb();
    const { data: an, error: aErr } = await db
      .from("analyses")
      .insert({ contract_notice_id: noticeId, doc_ids: selected, idempotency_key: ctx.idempotencyKey, status: "running" })
      .select("id")
      .single();
    if (aErr) throw new Error(aErr.message);

    try {
      const parts: any[] = [];
      const referenced_files: string[] = [];

      for (const ref of selected) {
        // External URL (SAM attachment) vs Storage path
        if (ref.startsWith("http")) {
          const res = await fetch(ref);
          if (res.ok) {
            const bytes = new Uint8Array(await res.arrayBuffer());
            parts.push({ inlineData: { data: toBase64(bytes), mimeType: "application/pdf" } });
            referenced_files.push(ref);
          }
        } else {
          if (PRIVATE_BUCKET) {
            const { data: signed, error: sErr } = await db.storage.from("contract_docs").createSignedUrl(ref, 3600);
            if (sErr || !signed?.signedUrl) continue;
            const res = await fetch(signed.signedUrl);
            if (res.ok) {
              const bytes = new Uint8Array(await res.arrayBuffer());
              parts.push({ inlineData: { data: toBase64(bytes), mimeType: "application/pdf" } });
              referenced_files.push(ref);
            }
          } else {
            const { data: pub } = db.storage.from("contract_docs").getPublicUrl(ref);
            const url = pub?.publicUrl;
            if (!url) continue;
            const res = await fetch(url);
            if (res.ok) {
              const bytes = new Uint8Array(await res.arrayBuffer());
              parts.push({ inlineData: { data: toBase64(bytes), mimeType: "application/pdf" } });
              referenced_files.push(ref);
            }
          }
        }
      }

      if (contractDescription?.trim()) {
        parts.push({ text: `Contract description:\n${contractDescription}` });
      }

      const model = ctx.genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
      const sys = `
You are a contract summarization engine. Output ONLY valid JSON for the schema below.
If unknown, return nulls or empty arrays — do not invent details.

Schema (JSON):
${JSON.stringify(SummarySchema)}
`.trim();

      const first = await model.generateContent({
        contents: [
          { role: "system", parts: [{ text: sys }] },
          { role: "user", parts },
        ],
      });

      const raw = first.response.text().trim().replace(/^```json\s*/i, "").replace(/```$/i, "").trim();

      let parsed: any;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = null;
      }

      if (!parsed || !validateSummary(parsed)) {
        const repair = `
Your previous output was invalid for the schema. Errors:
${JSON.stringify(validateSummary.errors, null, 2)}
Return corrected JSON ONLY (no prose). Schema again:
${JSON.stringify(SummarySchema)}
Original output:
${raw}
`.trim();

        const second = await model.generateContent({
          contents: [
            { role: "system", parts: [{ text: sys }] },
            { role: "user", parts: [{ text: repair }] },
          ],
        });
        const raw2 = second.response.text().trim().replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
        try {
          parsed = JSON.parse(raw2);
        } catch {
          parsed = null;
        }
        if (!parsed || !validateSummary(parsed)) {
          const e: any = new Error("Summary JSON invalid after repair");
          e.details = validateSummary.errors;
          throw e;
        }
      }

      await db
        .from("analyses")
        .update({ summary: { ...parsed, referenced_files }, status: "succeeded" })
        .eq("id", an.id);

      return { analysisId: an.id, summary: parsed, referenced_files };
    } catch (err: any) {
      await db.from("analyses").update({ status: "failed", error: String(err?.message || err) }).eq("id", an.id);
      const e: any = new Error("summarizeDocs failed");
      e.status = 500;
      e.details = err?.details;
      throw e;
    }
  },

  // ---- judge summary into GC vs Subs (placeholder judge using Gemini)
  async judgeBundle(args, ctx) {
    const analysisId = String(args?.analysisId || "");
    if (!analysisId) {
      const e: any = new Error("analysisId required");
      e.status = 400;
      throw e;
    }

    const db = makeDb();
    const { data: row, error } = await db.from("analyses").select("id, summary").eq("id", analysisId).single();
    if (error) throw new Error(error.message);
    if (!row?.summary) {
      const e: any = new Error("No summary found");
      e.status = 404;
      throw e;
    }

    const sys = `
You are a bid “judge.” Given the summary JSON, split requirements into:
- prime_contractor_requirements (array of strings)
- subcontractor_packages (array of { trade, scope_items[] })
Also output confidence (0..1) and a brief rationale.
Output ONLY valid JSON for this schema:
${JSON.stringify(JudgeSchema)}
`.trim();

    const model = ctx.genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    const first = await model.generateContent({
      contents: [
        { role: "system", parts: [{ text: sys }] },
        { role: "user", parts: [{ text: JSON.stringify(row.summary) }] },
      ],
    });

    let raw = first.response.text().trim().replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }

    if (!parsed || !validateJudge(parsed)) {
      const repair = `
Your previous output was invalid. Errors:
${JSON.stringify(validateJudge.errors, null, 2)}
Return corrected JSON ONLY:
${JSON.stringify(JudgeSchema)}
Original:
${raw}
`.trim();

      const second = await model.generateContent({
        contents: [
          { role: "system", parts: [{ text: sys }] },
          { role: "user", parts: [{ text: repair }] },
        ],
      });
      raw = second.response.text().trim().replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = null;
      }
      if (!parsed || !validateJudge(parsed)) {
        const e: any = new Error("Judge JSON invalid after repair");
        e.status = 422;
        e.details = validateJudge.errors;
        throw e;
      }
    }

    await db
      .from("analyses")
      .update({ judge: parsed, confidence: parsed.confidence ?? null })
      .eq("id", analysisId);

    const escalate = (parsed.confidence ?? 0) < 0.55;
    return { analysisId, judge: parsed, escalated: escalate };
  },
};

/* ==========================
   SYSTEM PROMPTS
========================== */
const SYSTEM_ASSISTANT = `
You are BlueGrid's assistant (SYS_orchestrator).
- If the user wants current opportunities, CALL "listContractDocs" or "summarizeDocs" appropriately.
- If the user asks to parse/extract a solicitation from pasted text, CALL "extractSolicitation".
- For classification into GC vs Subs, CALL "judgeBundle".
- Otherwise answer concisely.
- Never invent facts.
`;
const SYSTEM_EXTRACT = `
You are an extraction engine. Output ONLY JSON that matches this schema (no prose, no markdown):
${JSON.stringify(ExtractOutSchema)}
Rules:
- If a field is unknown, omit it.
- Dates must be YYYY-MM-DD if present.
- tradePackages lists common subcontractor trades if implied.
- Do not include properties not in the schema.
`;

/* ==========================
   MAIN HANDLER
========================== */
serve(
  async (req: Request) => {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

    let idempotencyKey: string | undefined;
    let message = "";

    try {
      console.log(VERSION);

      const apiKey = Deno.env.get("GOOGLE_API_KEY");
      if (!apiKey) return json({ version: VERSION, error: "Missing GOOGLE_API_KEY" }, 500);

      const body = await req.json().catch(() => ({}));
      message = typeof body?.message === "string" ? body.message : "";
      if (!message) {
        return json({ version: VERSION, error: "Body must be { message: string }", received: body }, 400);
      }

      idempotencyKey =
        (typeof body?.idempotencyKey === "string" && body.idempotencyKey) ||
        req.headers.get("x-idempotency-key") ||
        undefined;

      const genAI = new GoogleGenerativeAI(apiKey);
      const model = genAI.getGenerativeModel({
        model: MODEL,
        tools: { functionDeclarations },
        systemInstruction: { parts: [{ text: SYSTEM_ASSISTANT }] },
      });

      // First turn
      const first = await model.generateContent({
        contents: [{ role: "user", parts: [{ text: message }] }],
      });

      const cand = first.response.candidates?.[0];
      const part: any = cand?.content?.parts?.[0];
      const fnCall = part?.functionCall;

      if (fnCall?.name && TOOL_MAP[fnCall.name]) {
        let toolResult;
        try {
          toolResult = await TOOL_MAP[fnCall.name](fnCall.args, { idempotencyKey, genAI });
        } catch (err: any) {
          const status = err?.status || 500;
          await logInsert({
            idempotency_key: idempotencyKey,
            message,
            ok: false,
            error_text: String(err?.message || err),
            details: err?.details,
          });
          return json(
            {
              version: VERSION,
              ok: false,
              toolCall: fnCall,
              error: String(err?.message || err),
              details: err?.details,
            },
            status,
          );
        }

        // Second turn
        const second = await model.generateContent({
          contents: [
            { role: "user", parts: [{ text: message }] },
            { role: "model", parts: [{ functionCall: fnCall }] },
            { role: "tool", parts: [{ functionResponse: { name: fnCall.name, response: toolResult } }] },
          ],
        });

        await logInsert({
          idempotency_key: idempotencyKey,
          message,
          tool_called: fnCall.name,
          ok: true,
          response_text: second.response.text(),
          raw_tool: fnCall,
          raw_result: toolResult,
        });
        return json({ version: VERSION, idempotencyKey, text: second.response.text(), toolCall: fnCall, toolResult });
      }

      // no tool call
      await logInsert({
        idempotency_key: idempotencyKey,
        message,
        ok: true,
        response_text: first.response.text(),
      });
      return json({ version: VERSION, idempotencyKey, text: first.response.text() });
    } catch (e: any) {
      await logInsert({
        idempotency_key: idempotencyKey,
        message,
        ok: false,
        error_text: String(e?.message ?? e),
      });
      return json({ version: VERSION, ok: false, error: String(e?.message ?? e), stack: e?.stack }, 500);
    }
  },
  { onError: (e) => console.error(e) },
);
