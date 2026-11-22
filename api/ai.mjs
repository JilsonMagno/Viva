export const config = { maxDuration: 30 };

const SUPABASE_URL = process.env.SUPABASE_URL || "https://fmkmrrqseijcgcawqzoj.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || "sb_publishable__fM5rGKVNvICUJCoAJL6Jg_xZHtp9ES";

const PROVIDERS = {
  openai: { url: "https://api.openai.com/v1/chat/completions", model: "gpt-4o-mini" },
  groq: { url: "https://api.groq.com/openai/v1/chat/completions", model: "openai/gpt-oss-120b" },
  gemini: { url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", model: "gemini-3.5-flash-lite" },
  openrouter: { url: "https://openrouter.ai/api/v1/chat/completions", model: "openrouter/free" }
};

const VISION_PROVIDERS = new Set(["openai", "gemini", "openrouter"]);

const SYSTEM = [
  "Você é a Viva, assistente pessoal de saúde em português do Brasil.",
  "Responda em no máximo 5 frases curtas.",
  "Não faça diagnóstico, não prescreva remédio e não substitua orientação médica.",
  "Não recomende dietas extremas nem metas abaixo de 1200 kcal.",
  "Use o contexto do usuário (perfil, metas, registros e histórico) para personalizar a resposta; não invente dados que não estejam no contexto.",
  "Se a pergunta não for sobre alimentação, movimento, sono ou rotina, diga brevemente que só ajuda com esses temas."
].join(" ");

const VISION_SYSTEM = [
  "Você é a Viva, assistente de alimentação em português do Brasil.",
  "Analise a foto do prato e estime os alimentos, as porções e os valores nutricionais.",
  "Responda SOMENTE com JSON válido, sem markdown, no formato:",
  '{"items":[{"name":"arroz branco","grams":120,"kcal":154,"protein":3.0,"carbs":33.7,"fat":0.2}],"confidence":"media","note":"Estimativa visual."}',
  "Use no máximo 8 itens. Não invente precisão; se não tiver certeza, use confiança baixa.",
  "Use o contexto do usuário apenas para personalizar a estimativa; não invente dados ausentes.",
  "Não faça diagnóstico, não prescreva remédio e não substitua orientação médica."
].join(" ");

const SERVER_KEY = String(
  process.env.AI_API_KEY ||
  process.env.OPENAI_API_KEY ||
  process.env.GROQ_API_KEY ||
  process.env.GEMINI_API_KEY ||
  process.env.OPENROUTER_API_KEY ||
  ""
).trim();

function inferProvider(key) {
  if (/^gsk_/i.test(key)) return "groq";
  if (/^sk-or-/i.test(key)) return "openrouter";
  if (/^AIza/i.test(key)) return "gemini";
  if (/^sk-/i.test(key)) return "openai";
  return "openrouter";
}

const SERVER_PROVIDER = Object.hasOwn(PROVIDERS, process.env.AI_PROVIDER) ? process.env.AI_PROVIDER : inferProvider(SERVER_KEY);
const SERVER_MODEL = String(process.env.AI_MODEL || "").trim().slice(0, 120) || PROVIDERS[SERVER_PROVIDER]?.model || PROVIDERS.openrouter.model;
const SERVER_VISION_MODEL = String(process.env.AI_VISION_MODEL || "").trim().slice(0, 120) || SERVER_MODEL;
const SERVER_VISION = VISION_PROVIDERS.has(SERVER_PROVIDER);
const RATE = new Map();
const RATE_LIMIT = 30;
const RATE_WINDOW = 60_000;
const IMAGE_MAX_CHARS = 5_000_000;
const CONTEXT_MAX_CHARS = 24_000;

function rateLimited(userId) {
  const now = Date.now();
  const entry = RATE.get(userId);
  if (!entry || now - entry.start > RATE_WINDOW) {
    RATE.set(userId, { start: now, count: 1 });
    return false;
  }
  entry.count += 1;
  if (RATE.size > 500) {
    for (const [key, value] of RATE) if (now - value.start > RATE_WINDOW) RATE.delete(key);
  }
  return entry.count > RATE_LIMIT;
}

function json(res, status, body) {
  res.status(status);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.send(JSON.stringify(body));
}

function safeError(raw, key) {
  const text = String(raw || "").replaceAll(key, "***").slice(0, 300);
  return text || "O provedor recusou a requisição.";
}

async function geminiVision({ key, model, system, prompt, image, mime }) {
  const match = image.match(/^data:(image\/[a-z]+);base64,(.+)$/i);
  const data = match?.[2] || "";
  const upstream = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: prompt }, { inline_data: { mime_type: mime, data } }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 900 }
      })
    }
  );
  const payload = await upstream.json().catch(() => null);
  if (!upstream.ok) {
    return { status: upstream.status, error: safeError(payload?.error?.message || payload?.message, key) };
  }
  const parts = payload?.candidates?.[0]?.content?.parts || [];
  const answer = parts.map((part) => part.text).filter(Boolean).join("").trim();
  return answer ? { status: 200, answer } : { status: 502, error: "O provedor não devolveu uma estimativa." };
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    return json(res, 200, {
      configured: !!SERVER_KEY,
      provider: SERVER_PROVIDER,
      model: SERVER_MODEL,
      vision: !!SERVER_KEY && SERVER_VISION
    });
  }
  if (req.method !== "POST") return json(res, 405, { error: "method_not_allowed" });

  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Bearer ")) return json(res, 401, { error: "unauthorized" });

  let userId = "anon";
  try {
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_KEY, Authorization: auth }
    });
    if (!userRes.ok) return json(res, 401, { error: "unauthorized" });
    const user = await userRes.json().catch(() => null);
    userId = user?.id || "anon";
  } catch {
    return json(res, 503, { error: "supabase_unavailable" });
  }
  if (rateLimited(userId)) return json(res, 429, { error: "rate_limited" });

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body && typeof body === "object" ? body : {};

  const question = String(body.question || body.message || "").trim().slice(0, 2000);
  const image = String(body.image || "").trim();
  if (!question) return json(res, 400, { error: "missing_question" });
  if (image) {
    if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/i.test(image)) {
      return json(res, 400, { error: "invalid_image", message: "Envie uma foto JPEG, PNG ou WebP." });
    }
    if (image.length > IMAGE_MAX_CHARS) {
      return json(res, 413, { error: "image_too_large", message: "A foto é grande demais." });
    }
  }

  const userKey = String(body.apiKey || "").trim().slice(0, 500);
  const key = userKey || SERVER_KEY;
  if (!key) {
    return json(res, 503, {
      error: "ai_not_configured",
      message: "A IA do app ainda não foi configurada. Use as respostas locais ou salve uma chave em Perfil."
    });
  }

  const providerName = userKey
    ? (Object.hasOwn(PROVIDERS, body.provider) ? body.provider : "openai")
    : SERVER_PROVIDER;
  const provider = PROVIDERS[providerName];
  const model = userKey
    ? (String(body.model || provider.model).trim().slice(0, 120) || provider.model)
    : SERVER_MODEL;
  const visionModel = userKey ? model : SERVER_VISION_MODEL;

  if (image && !VISION_PROVIDERS.has(providerName)) {
    return json(res, 400, {
      error: "vision_unsupported",
      message: "Este provedor não analisa fotos. Use OpenAI, Gemini ou OpenRouter."
    });
  }

  const isVision = !!image;
  const context = body.context && typeof body.context === "object" ? JSON.stringify(body.context).slice(0, CONTEXT_MAX_CHARS) : "";
  const userText = context ? `Contexto do usuário e do app (JSON): ${context}\n\nPergunta: ${question}` : question;

  if (isVision && providerName === "gemini") {
    const mime = image.match(/^data:(image\/[a-z]+);base64,/i)?.[1] || "image/jpeg";
    let result;
    try {
      result = await geminiVision({ key, model: visionModel, system: VISION_SYSTEM, prompt: userText, image, mime });
    } catch {
      return json(res, 502, { error: "provider_unreachable" });
    }
    if (result.status !== 200) return json(res, result.status, { error: "provider_error", message: result.error });
    return json(res, 200, { answer: result.answer });
  }

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${key}`
  };
  if (providerName === "openrouter") {
    headers["HTTP-Referer"] = "https://viva-rouge-omega.vercel.app";
    headers["X-Title"] = "Viva";
  }

  const messages = [{ role: "system", content: isVision ? VISION_SYSTEM : SYSTEM }];
  if (isVision) {
    messages.push({
      role: "user",
      content: [
        { type: "text", text: userText },
        { type: "image_url", image_url: { url: image } }
      ]
    });
  } else {
    messages.push({ role: "user", content: userText });
  }

  let upstream;
  try {
    upstream = await fetch(provider.url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: isVision ? visionModel : model,
        messages,
        temperature: isVision ? 0.2 : 0.4,
        max_tokens: isVision ? 900 : 300
      })
    });
  } catch {
    return json(res, 502, { error: "provider_unreachable" });
  }

  const data = await upstream.json().catch(() => null);
  if (!upstream.ok) {
    const raw = data?.error?.message || data?.message || "";
    return json(res, upstream.status, { error: "provider_error", message: safeError(raw, key) });
  }

  const answer = data?.choices?.[0]?.message?.content;
  if (!answer || typeof answer !== "string") return json(res, 502, { error: "empty_answer" });
  return json(res, 200, { answer: answer.trim() });
}
