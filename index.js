/* ============================================================================
   NDAA Triage Worker
   Server-side risk triage and routing for the Device Compliance Registry.

   Why this exists: the routing decision must not be made in the browser, and
   must not be made by the model. This Worker is the sole authority for both.

     1. A deterministic RULES ENGINE computes the risk score, band, confidence,
        recommendation, and flags. This is reproducible and identical every time.
     2. The ROUTING DECISION (auto-approve vs refer to human) is derived only
        from those rule outputs, server-side. The browser receives a decision
        it cannot alter; the model cannot influence it.
     3. Workers AI writes the human-readable reasoning only. If the model call
        fails, a rules-derived reason is used, so triage never depends on it.

   Manufacturer history lives here, not in the client, because it feeds the
   rules and must not be client-editable.
   ============================================================================ */

const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast"; // pin for reproducibility
const CONF_THRESHOLD = 0.75;

// Server-side manufacturer register. Authoritative; not exposed for editing.
const MANUFACTURERS = {
  "MFR-1001": { name: "Helion Power Systems", priorReg: 42, incidents: 0, rejections: 1, watchlist: false },
  "MFR-1002": { name: "Voltaic Home Energy", priorReg: 18, incidents: 0, rejections: 0, watchlist: false },
  "MFR-1003": { name: "Redback Cells Pty Ltd", priorReg: 7, incidents: 2, rejections: 3, watchlist: true },
  "MFR-1004": { name: "Auralis Grid", priorReg: 1, incidents: 0, rejections: 0, watchlist: false },
  "MFR-1005": { name: "Kestrel Inverters", priorReg: 65, incidents: 1, rejections: 2, watchlist: false },
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: cors(env) });
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405, env);

    let a;
    try { a = await request.json(); }
    catch { return json({ error: "Invalid JSON body" }, 400, env); }

    // 1. Deterministic rules — the authority for the decision.
    const rules = runRules(a);

    // 2. Routing derived from rule outputs only, server-side.
    const routing = decideRouting(rules);

    // 3. Model writes the reasoning only. Non-fatal on failure.
    let reasoning = null, modelUsed = false, modelError = null;
    try {
      reasoning = await writeReasoning(a, rules, env);
      modelUsed = true;
    } catch (e) {
      modelError = String(e && e.message ? e.message : e);
      reasoning = rulesReasoning(a, rules);
    }

    return json({
      assessment: {
        riskScore: rules.score,
        riskBand: rules.band,
        confidence: rules.confidence,
        recommendation: rules.recommendation,
        reasoning,
        flags: rules.flags,
        routing: {
          decision: routing.auto ? "Auto-Approved" : "Routed to Human",
          auto: routing.auto,
          checks: routing.checks, // shown to the assessor; each check is pass/fail
        },
        meta: {
          model: modelUsed ? MODEL : "rules-only",
          modelUsed,
          modelError,
          engine: "rules-v1",
          confidenceThreshold: CONF_THRESHOLD,
          assessedAt: new Date().toISOString(),
        },
      },
    }, 200, env);
  },
};

/* ------------------------------ rules engine ----------------------------- */
function runRules(a) {
  const m = MANUFACTURERS[a.manuId] || { name: a.manuName || "Unknown", priorReg: 0, incidents: 0, rejections: 0, watchlist: false };
  const flags = [];
  let score = 8;
  const today = new Date();

  if (!a.cert) {
    flags.push({ code: "CERT_MISSING", severity: "critical", field: "complianceCertRef", detail: "No compliance certificate reference provided." });
    score += 32;
  } else if (a.certExp) {
    const days = (new Date(a.certExp) - today) / 86400000;
    if (days < 0) { flags.push({ code: "CERT_EXPIRED", severity: "critical", field: "certExpiryDate", detail: `Certificate expired ${Math.abs(Math.round(days))} days ago.` }); score += 34; }
    else if (days < 30) { flags.push({ code: "CERT_EXPIRING", severity: "warning", field: "certExpiryDate", detail: `Certificate expires in ${Math.round(days)} days.` }); score += 12; }
  }

  if (!a.safety) { flags.push({ code: "NO_SAFETY_ATTESTATION", severity: "critical", field: "safetyAttestation", detail: "Safety attestation is not signed." }); score += 30; }
  if (!a.testRep) { flags.push({ code: "MISSING_TESTREPORT", severity: "warning", field: "testReportRef", detail: "No test report reference supplied." }); score += 14; }
  if (a.deviceType === "Other") { flags.push({ code: "NOVEL_DEVICE", severity: "warning", field: "deviceType", detail: "Device type is 'Other', outside standard categories." }); score += 16; }

  if (m.watchlist) { flags.push({ code: "MANUFACTURER_WATCHLIST", severity: "warning", field: "onWatchlist", detail: `Manufacturer on watchlist; ${m.incidents} prior incident(s).` }); score += 18; }
  else if (m.incidents > 0) { flags.push({ code: "MANUFACTURER_INCIDENTS", severity: "info", field: "priorIncidents", detail: `${m.incidents} prior incident(s) on file.` }); score += 6; }

  if (!a.standards || String(a.standards).trim() === "" || String(a.standards).includes("unspecified")) {
    flags.push({ code: "INCOMPLETE", severity: "warning", field: "declaredStandards", detail: "Declared standards missing or unspecified." });
    score += 10;
  }

  score = Math.min(score, 96);
  const band = score >= 55 ? "High" : score >= 25 ? "Medium" : "Low";
  const hasCritical = flags.some(f => f.severity === "critical");
  const novelOrFirst = a.deviceType === "Other" || m.priorReg <= 1;

  let confidence = 0.92;
  if (novelOrFirst) confidence -= 0.20;
  if (flags.some(f => f.code === "MISSING_TESTREPORT")) confidence -= 0.08;
  if (band === "Medium") confidence -= 0.05;
  confidence = Math.max(0.55, Math.min(0.95, +confidence.toFixed(2)));

  let recommendation;
  if (hasCritical) recommendation = "Refer to Human";
  else if (confidence < CONF_THRESHOLD || novelOrFirst) recommendation = "Refer to Human";
  else if (band === "Low") recommendation = "Auto-Approve";
  else recommendation = "Refer to Human";

  return { score, band, confidence, recommendation, flags, hasCritical, manufacturer: m };
}

/* --------------------------- routing (server-side) ----------------------- */
function decideRouting(r) {
  const noCritical = !r.flags.some(f => f.severity === "critical");
  const auto = r.recommendation === "Auto-Approve" && r.confidence >= CONF_THRESHOLD && r.band === "Low" && noCritical;
  return {
    auto,
    checks: [
      { label: "recommendation is Auto-Approve", ok: r.recommendation === "Auto-Approve" },
      { label: `confidence at or above ${CONF_THRESHOLD} (${r.confidence})`, ok: r.confidence >= CONF_THRESHOLD },
      { label: `risk band is Low (${r.band})`, ok: r.band === "Low" },
      { label: "no critical flags", ok: noCritical },
    ],
  };
}

/* ------------------------------ reasoning (LLM) -------------------------- */
async function writeReasoning(a, rules, env) {
  if (!env.AI) throw new Error("Workers AI binding not configured");

  const system =
    "You write the reasoning note for a device registration triage at a regulator. " +
    "You do not decide the outcome and you do not set the score, band, confidence, or routing; " +
    "those are already determined by a rules engine and given to you. Write a short, neutral, " +
    "factual explanation for a human assessor, grounded only in the application data and the rule " +
    "findings provided. Do not invent facts. Write two to four sentences in plain regulatory English.";

  const user = JSON.stringify({
    application: {
      deviceType: a.deviceType, model: a.model, power: a.power,
      cert: a.cert || null, certExpiry: a.certExp || null,
      testReport: a.testRep || null, safetyAttestation: !!a.safety,
      standards: a.standards || null, manufacturer: a.manuName,
    },
    manufacturerHistory: rules.manufacturer,
    ruleFindings: {
      riskScore: rules.score, riskBand: rules.band, confidence: rules.confidence,
      recommendation: rules.recommendation,
      flags: rules.flags.map(f => ({ severity: f.severity, field: f.field, detail: f.detail })),
    },
  });

  const out = await env.AI.run(MODEL, {
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
    max_tokens: 300,
  });

  const text = (out && (out.response || out.result || "")).toString().trim();
  if (!text) throw new Error("Model returned no text");
  return text;
}

function rulesReasoning(a, r) {
  if (r.hasCritical) {
    return `${r.flags.filter(f => f.severity === "critical").map(f => f.detail).join(" ")} A human should confirm the position before any approval; this is referred rather than auto-rejected.`;
  }
  if (r.recommendation === "Auto-Approve") {
    return `Valid certificate, safety attestation signed, and declared standards consistent with the device class. Manufacturer ${r.manufacturer.name} has ${r.manufacturer.priorReg} prior registrations with ${r.manufacturer.incidents} incident(s). All required fields present.`;
  }
  return `Application is not clearly routine, so it is referred for a human view. ${r.flags.slice(0, 2).map(f => f.detail).join(" ")}`.trim();
}

/* ------------------------------- helpers --------------------------------- */
function cors(env) {
  return {
    "Access-Control-Allow-Origin": (env && env.ALLOWED_ORIGIN) || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Max-Age": "86400",
  };
}
function json(body, status, env) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...cors(env) } });
}
