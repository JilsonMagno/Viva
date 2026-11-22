export const config = { maxDuration: 30 };

const SUPABASE_URL = process.env.SUPABASE_URL || "https://fmkmrrqseijcgcawqzoj.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || "sb_publishable__fM5rGKVNvICUJCoAJL6Jg_xZHtp9ES";

const PROVIDERS = {
  openai: { url: "https://api.openai.com/v1/chat/completions", model: "gpt-4o-mini" },
  groq: { url: "https://api.groq.com/openai/v1/chat/completions", model: "llama-3.3-70b-versatile" },
  gemini: { url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", model: "gemini-2.0-flash" },
  openrouter: { url: "https://openrouter.ai/api/v1/chat/completions", model: "meta-llama/llama-3.3-70b-instruct:free" }
};

const SYSTEM = [
  "Você é a Viva, assistente pessoal de saúde em português do Brasil.",
  "Responda em no máximo 5 frases curtas.",
  "Não faça diagnóstico, não prescreva remédio e não substitua orientação médica.",
  "Se a pergunta não for sobre alimentação, movimento, sono ou rotina, diga brevemente que só ajuda com esses temas."
].join(" ");

function json(res, status, body) {
  res.status(status);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.send(JSON.stringify(body));
}

export default async function handler(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "method_not_allowed" });

  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Bearer ")) return json(res, 401, { error: "unauthorized" });

  try {
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_KEY, Authorization: auth }
    });
    if (!userRes.ok) return json(res, 401, { error: "unauthorized" });
  } catch {
    return json(res, 503, { error: "supabase_unavailable" });
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body && typeof body === "object" ? body : {};

  const key = String(body.apiKey || "").trim().slice(0, 500);
  if (!key) return json(res, 400, { error: "missing_api_key" });

  const question = String(body.question || body.message || "").trim().slice(0, 2000);
  if (!question) return json(res, 400, { error: "missing_question" });

  const providerName = Object.hasOwn(PROVIDERS, body.provider) ? body.provider : "openai";
  const provider = PROVIDERS[providerName];
  const model = String(body.model || provider.model).trim().slice(0, 120) || provider.model;

  const context = body.context && typeof body.context === "object" ? JSON.stringify(body.context).slice(0, 4000) : "";
  const userContent = context ? `Contexto do dia (JSON): ${context}\n\nPergunta: ${question}` : question;

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${key}`
  };
  if (providerName === "openrouter") {
    headers["HTTP-Referer"] = "https://viva-rouge-omega.vercel.app";
    headers["X-Title"] = "Viva";
  }

  let upstream;
  try {
    upstream = await fetch(provider.url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: userContent }
        ],
        temperature: 0.4,
        max_tokens: 300
      })
    });
  } catch {
    return json(res, 502, { error: "provider_unreachable" });
  }

  const data = await upstream.json().catch(() => null);
  if (!upstream.ok) {
    const raw = data?.error?.message || data?.message || "";
    const safe = String(raw).replaceAll(key, "***").slice(0, 300);
    return json(res, upstream.status, { error: "provider_error", message: safe || "O provedor recusou a requisição." });
  }

  const answer = data?.choices?.[0]?.message?.content;
  if (!answer || typeof answer !== "string") return json(res, 502, { error: "empty_answer" });
  return json(res, 200, { answer: answer.trim() });
}
