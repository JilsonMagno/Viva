let failed = 0;
function check(name, fn) {
  return Promise.resolve().then(fn).then(() => console.log(`ok  ${name}`)).catch((error) => {
    failed += 1;
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

let insertMode = "ok";
let inserted = null;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options = {}) => {
  const target = String(url);
  if (target.includes("/auth/v1/user")) {
    const token = options.headers.Authorization;
    return token === "Bearer invalid"
      ? { ok: false, json: async () => ({}) }
      : { ok: true, json: async () => ({ id: "user-test" }) };
  }
  if (target.includes("/rest/v1/viva_reports")) {
    inserted = JSON.parse(options.body);
    return insertMode === "ok" ? { ok: true } : { ok: false, status: 500 };
  }
  return { ok: false, status: 404 };
};

const { default: handler } = await import("../api/report.mjs?report-test");

await check("GET é recusado", async () => {
  const res = response();
  await handler({ method: "GET", headers: {} }, res);
  assert(res.statusCode === 405, `status ${res.statusCode}`);
});

await check("POST sem JWT é recusado", async () => {
  const res = response();
  await handler({ method: "POST", headers: {}, body: { question: "teste" } }, res);
  assert(res.statusCode === 401, `status ${res.statusCode}`);
});

await check("JWT inválido é recusado", async () => {
  const res = response();
  await handler(request({ question: "teste" }, { authorization: "Bearer invalid" }), res);
  assert(res.statusCode === 401, `status ${res.statusCode}`);
});

await check("relatório válido é gravado com o usuário do JWT", async () => {
  inserted = null;
  const res = response();
  await handler(request({
    version: "2.15.7",
    question: "2 fatias de queijo",
    answer: "Não consegui",
    context: { screen: "viva" }
  }), res);
  assert(res.statusCode === 200, `status ${res.statusCode}`);
  assert(res.body.stored === true, "stored");
  assert(inserted.user_id === "user-test", "user_id");
  assert(inserted.app_version === "2.15.7", "versão");
  assert(inserted.message === "2 fatias de queijo", "mensagem");
  assert(inserted.context.screen === "viva", "contexto");
});

await check("falha da tabela ainda registra no log e responde 202", async () => {
  insertMode = "fail";
  const res = response();
  const originalError = console.error;
  console.error = () => {};
  await handler(request({ question: "teste", context: {} }), res);
  console.error = originalError;
  insertMode = "ok";
  assert(res.statusCode === 202, `status ${res.statusCode}`);
  assert(res.body.stored === false, "stored");
});

globalThis.fetch = originalFetch;
if (failed) {
  console.error(`\n${failed} falha(s).`);
  process.exit(1);
}
console.log("\n5 verificações ok, 0 falha(s).");
