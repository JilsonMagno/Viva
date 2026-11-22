// Edge Function "assistente": recebe uma pergunta, confere o JWT do Supabase
// e responde com a OpenAI. A chave da OpenAI nunca vai ao navegador.
//
// Segredos necessários (supabase secrets set):
//   OPENAI_API_KEY   chave da OpenAI
//   OPENAI_MODEL     ID exato do modelo, ex.: gpt-4.1-mini
// SUPABASE_URL e SUPABASE_ANON_KEY são injetados pelo Supabase.

import { createClient } from "npm:@supabase/supabase-js@2";

const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") || "*";
const CORS = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

const INSTRUCTIONS = [
  "Você é a Viva, assistente pessoal de saúde em português do Brasil.",
  "Responda em no máximo 5 frases curtas, com linguagem simples e acolhedora.",
  "Você não é médica: não diagnostique, não prescreva remédios e não substitua nutricionista ou médico.",
  "Quando a pergunta envolver sintomas, dor, medicação ou transtorno alimentar, oriente procurar um profissional de saúde.",
  "Nunca invente números, exames ou dados do usuário: você não recebe o diário dele."
].join(" ");

const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 20;
const hits = new Map<string, number[]>();

function limited(userId: string): boolean {
  const now = Date.now();
  const recent = (hits.get(userId) ?? []).filter((at) => now - at < WINDOW_MS);
  recent.push(now);
  hits.set(userId, recent);
  if (hits.size > 5000) hits.clear();
  return recent.length > MAX_PER_WINDOW;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" }
  });
}

function textFromResponse(payload: any): string {
  if (typeof payload?.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text.trim();
  }
  const parts: string[] = [];
  for (const item of payload?.output ?? []) {
    for (const content of item?.content ?? []) {
      if (typeof content?.text === "string") parts.push(content.text);
    }
  }
  return parts.join("\n").trim();
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const authorization = req.headers.get("Authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) return json({ error: "unauthorized" }, 401);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authorization } }, auth: { persistSession: false } }
  );

  const { data: userData, error: userError } = await supabase.auth.getUser();
  const user = userData?.user;
  if (userError || !user) return json({ error: "unauthorized" }, 401);

  if (limited(user.id)) return json({ error: "rate_limited" }, 429);

  let body: any = null;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const question = typeof body?.question === "string" ? body.question.trim() : "";
  if (!question) return json({ error: "empty_question" }, 400);
  if (question.length > 1200) return json({ error: "question_too_long" }, 400);

  const apiKey = Deno.env.get("OPENAI_API_KEY");
  const model = Deno.env.get("OPENAI_MODEL");
  if (!apiKey || !model) return json({ error: "ai_not_configured" }, 503);

  let upstream: Response;
  try {
    upstream = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        instructions: INSTRUCTIONS,
        input: question,
        max_output_tokens: 500,
        store: false
      })
    });
  } catch {
    return json({ error: "upstream_unreachable" }, 502);
  }

  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => "");
    console.error("openai_error", upstream.status, detail.slice(0, 500));
    if (upstream.status === 429) return json({ error: "upstream_rate_limited" }, 429);
    if (upstream.status === 401 || upstream.status === 403) return json({ error: "ai_not_configured" }, 503);
    return json({ error: "upstream_error" }, 502);
  }

  const payload = await upstream.json().catch(() => null);
  const answer = textFromResponse(payload);
  if (!answer) return json({ error: "empty_answer" }, 502);

  return json({ answer, model });
});
