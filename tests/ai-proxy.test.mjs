const results = [];
let failed = 0;

function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      results.push(`ok  ${name}`);
      console.log(`ok  ${name}`);
    })
    .catch((error) => {
      failed += 1;
      results.push(`FAIL ${name}\n     ${error.message}`);
      console.error(`FAIL ${name}\n     ${error.message}`);
    });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function response() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) { this.statusCode = code; return this; },
    setHeader(key, value) { this.headers[key.toLowerCase()] = value; },
    send(text) { this.body = JSON.parse(text); }
  };
}

function request(body, headers = {}) {
  return { method: "POST", headers: { authorization: "Bearer token", ...headers }, body };
}

const calls = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options = {}) => {
  const target = String(url);
  if (target.includes("/auth/v1/user")) {
    return { ok: true, json: async () => ({ id: "user-test" }) };
  }
  calls.push({ url: target, options, body: options.body ? JSON.parse(options.body) : null });
  if (target.includes("generativelanguage.googleapis.com")) {
    return {
      ok: true,
      json: async () => ({ candidates: [{ content: { parts: [{ text: '{"items":[],"confidence":"baixa","note":"teste"}' }] } }] })
    };
  }
  if (target.includes("api.openai.com") || target.includes("api.groq.com") || target.includes("openrouter.ai")) {
    return { ok: true, json: async () => ({ choices: [{ message: { content: "resposta de teste" } }] }) };
  }
  throw new Error(`fetch inesperado: ${target}`);
};

process.env.AI_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.GROQ_API_KEY = "";
process.env.GEMINI_API_KEY = "";
process.env.OPENROUTER_API_KEY = "";
process.env.AI_PROVIDER = "";
process.env.AI_MODEL = "";
const { default: handler } = await import("../api/ai.mjs?no-server");

const image = "data:image/jpeg;base64,AAAA";

await check("GET sem chave do servidor informa IA não configurada", async () => {
  const res = response();
  await handler({ method: "GET", headers: {} }, res);
  assert(res.statusCode === 200, "status");
  assert(res.body.configured === false, "configured");
  assert(res.body.vision === false, "vision");
  assert(res.body.provider === "openrouter", "OpenRouter gratuito como padrão");
  assert(res.body.model === "openrouter/free", "modelo gratuito como padrão");
});

await check("POST sem JWT é recusado", async () => {
  const res = response();
  await handler({ method: "POST", headers: {}, body: { question: "oi" } }, res);
  assert(res.statusCode === 401, `status ${res.statusCode}`);
  assert(res.body.error === "unauthorized", "erro");
});

await check("foto com chave OpenAI usa visão e envia imagem", async () => {
  calls.length = 0;
  const res = response();
  await handler(request({ question: "analise", apiKey: "sk-user", provider: "openai", image }), res);
  assert(res.statusCode === 200, `status ${res.statusCode}`);
  assert(res.body.answer === "resposta de teste", "resposta");
  assert(calls.length === 1, "uma chamada ao provedor");
  assert(calls[0].url.includes("api.openai.com"), "provedor OpenAI");
  assert(calls[0].options.headers.Authorization === "Bearer sk-user", "chave do usuário");
  const content = calls[0].body.messages[1].content;
  assert(Array.isArray(content), "conteúdo multimodal");
  assert(content[1].image_url.url === image, "imagem enviada");
  assert(calls[0].body.model === "gpt-4o-mini", "modelo padrão");
});

await check("foto com Groq é recusada antes de chamar o provedor", async () => {
  calls.length = 0;
  const res = response();
  await handler(request({ question: "analise", apiKey: "gsk_user", provider: "groq", image }), res);
  assert(res.statusCode === 400, `status ${res.statusCode}`);
  assert(res.body.error === "vision_unsupported", "erro");
  assert(calls.length === 0, "não deveria chamar o provedor");
});

await check("foto com Gemini usa o endpoint nativo e inline_data", async () => {
  calls.length = 0;
  const res = response();
  await handler(request({ question: "analise", apiKey: "AIzaUser", provider: "gemini", image }), res);
  assert(res.statusCode === 200, `status ${res.statusCode}`);
  assert(calls.length === 1, "uma chamada");
  assert(calls[0].url.includes("models/gemini-3.5-flash-lite:generateContent"), "endpoint Gemini");
  assert(calls[0].body.contents[0].parts[1].inline_data.data === "AAAA", "imagem inline");
});

await check("Groq usa o modelo gratuito de texto", async () => {
  calls.length = 0;
  const res = response();
  await handler(request({ question: "oi", apiKey: "gsk_user", provider: "groq" }), res);
  assert(res.statusCode === 200, `status ${res.statusCode}`);
  assert(calls[0].url.includes("api.groq.com"), "provedor Groq");
  assert(calls[0].body.model === "openai/gpt-oss-120b", "modelo gratuito Groq");
});

await check("OpenRouter usa o modelo gratuito com visão", async () => {
  calls.length = 0;
  const res = response();
  await handler(request({ question: "analise", apiKey: "sk-or-user", provider: "openrouter", image }), res);
  assert(res.statusCode === 200, `status ${res.statusCode}`);
  assert(calls[0].url.includes("openrouter.ai"), "provedor OpenRouter");
  assert(calls[0].body.model === "openrouter/free", "modelo gratuito OpenRouter");
});

await check("imagem em formato não permitido é recusada", async () => {
  const res = response();
  await handler(request({ question: "analise", apiKey: "sk-user", provider: "openai", image: "data:image/gif;base64,AAAA" }), res);
  assert(res.statusCode === 400, `status ${res.statusCode}`);
  assert(res.body.error === "invalid_image", "erro");
});

await check("chave do servidor é usada quando o usuário não envia chave", async () => {
  process.env.AI_API_KEY = "sk-server";
  process.env.AI_MODEL = "gpt-4o-mini";
  const { default: serverHandler } = await import("../api/ai.mjs?server");
  calls.length = 0;
  const get = response();
  await serverHandler({ method: "GET", headers: {} }, get);
  assert(get.body.configured === true, "configured");
  assert(get.body.vision === true, "vision");
  const res = response();
  await serverHandler(request({ question: "analise", image }), res);
  assert(res.statusCode === 200, `status ${res.statusCode}`);
  assert(calls.length === 1, "uma chamada");
  assert(calls[0].options.headers.Authorization === "Bearer sk-server", "chave do servidor");
});

globalThis.fetch = originalFetch;
console.log(`\n${results.length} verificações, ${failed} falha(s).\n`);
process.exit(failed ? 1 : 0);
