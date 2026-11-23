export const config = { maxDuration: 15 };

const SUPABASE_URL = process.env.SUPABASE_URL || "https://fmkmrrqseijcgcawqzoj.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || "sb_publishable__fM5rGKVNvICUJCoAJL6Jg_xZHtp9ES";
const TABLE = "viva_reports";
const MAX_MESSAGE = 8000;
const MAX_CONTEXT = 24000;

function json(res, status, body) {
  res.status(status);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.send(JSON.stringify(body));
}

function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body); } catch { return null; }
  }
  return null;
}

function clip(value, max) {
  return String(value || "").slice(0, max);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    json(res, 405, { error: "method_not_allowed" });
    return;
  }

  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token) {
    json(res, 401, { error: "unauthorized" });
    return;
  }

  const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}` }
  }).catch(() => null);
  if (!userRes || !userRes.ok) {
    json(res, 401, { error: "unauthorized" });
    return;
  }
  const user = await userRes.json().catch(() => null);
  if (!user?.id) {
    json(res, 401, { error: "unauthorized" });
    return;
  }

  const body = readBody(req);
  if (!body || typeof body !== "object") {
    json(res, 400, { error: "invalid_body" });
    return;
  }

  const report = {
    user_id: user.id,
    app_version: clip(body.version, 40),
    kind: clip(body.kind || "chat", 40),
    message: clip(body.question, MAX_MESSAGE),
    context: body.context && typeof body.context === "object" ? body.context : body
  };
  const contextSize = JSON.stringify(report.context).length;
  if (contextSize > MAX_CONTEXT) {
    report.context = { truncated: true, size: contextSize };
  }

  const insert = await fetch(`${SUPABASE_URL}/rest/v1/${TABLE}`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal"
    },
    body: JSON.stringify(report)
  }).catch(() => null);

  if (!insert || !insert.ok) {
    console.error("viva_report_fallback", JSON.stringify(report));
    json(res, 202, { ok: true, stored: false });
    return;
  }

  json(res, 200, { ok: true, stored: true });
}
