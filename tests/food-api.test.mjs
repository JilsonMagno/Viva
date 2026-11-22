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

const calls = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options = {}) => {
  const target = String(url);
  if (target.includes("/auth/v1/user")) return { ok: true, json: async () => ({ id: "user-test" }) };
  calls.push(target);
  const query = new URL(target).searchParams.get("search_terms");
  if (query === "esfihas") return { ok: true, json: async () => ({ products: [] }) };
  if (query.includes("sem")) return { ok: true, json: async () => ({ products: [] }) };
  if (query === "incompleto") {
    return {
      ok: true,
      json: async () => ({
        products: [{ code: "1", product_name: "Incompleto", nutriments: { "energy-kcal_100g": 100 } }]
      })
    };
  }
  return {
    ok: true,
    json: async () => ({
      products: [
        {
          code: "789",
          product_name: query.startsWith("esfiha") ? "Esfiha de carne" : query === "big mac" ? "Big Mac" : query === "chia" ? "Chia" : "Alimento de teste",
          brands: "Marca teste",
          quantity: "219 g",
          nutriments: {
            "energy-kcal_100g": 250,
            proteins_100g: 10,
            carbohydrates_100g: 30,
            fat_100g: 10
          }
        }
      ]
    })
  };
};

const { default: handler } = await import("../api/food.mjs?food-test");

await check("GET informa a fonte", async () => {
  const res = response();
  await handler({ method: "GET", headers: {} }, res);
  assert(res.statusCode === 200, "status");
  assert(res.body.configured === true, "configured");
  assert(res.body.source === "Open Food Facts", "source");
});

await check("POST sem JWT é recusado", async () => {
  const res = response();
  await handler({ method: "POST", headers: {}, body: { name: "esfiha" } }, res);
  assert(res.statusCode === 401, `status ${res.statusCode}`);
  assert(res.body.error === "unauthorized", "erro");
});

await check("nome vazio é recusado", async () => {
  const res = response();
  await handler(request({ name: " " }), res);
  assert(res.statusCode === 400, `status ${res.statusCode}`);
  assert(res.body.error === "missing_name", "erro");
});

await check("alimento encontrado usa valores por 100 g", async () => {
  calls.length = 0;
  const res = response();
  await handler(request({ name: "esfiha" }), res);
  assert(res.statusCode === 200, `status ${res.statusCode}`);
  assert(res.body.found === true, "found");
  assert(res.body.food.name === "Esfiha de carne", "nome");
  assert(res.body.food.kcal === 250, "kcal");
  assert(res.body.food.protein === 10, "proteína");
  assert(res.body.food.servingGrams === 219, "peso da porção");
  assert(res.body.food.source === "Open Food Facts", "fonte");
  assert(calls.length === 1, "uma busca");
  assert(calls[0].includes("search_terms=esfiha"), "termo pesquisado");
});

await check("plural é padronizado para o singular", async () => {
  calls.length = 0;
  const res = response();
  await handler(request({ name: "esfihas de carne" }), res);
  assert(res.statusCode === 200, `status ${res.statusCode}`);
  assert(res.body.food.name === "Esfiha de carne", "nome");
  assert(calls.length === 1, "uma busca");
  assert(calls[0].includes("search_terms=esfiha%20de%20carne"), "termo singular");
});

await check("nome sujo é padronizado antes da busca", async () => {
  calls.length = 0;
  const res = response();
  await handler(request({ name: "  1 BIG-MAC, por favor " }), res);
  assert(res.statusCode === 200, `status ${res.statusCode}`);
  assert(res.body.food.name === "Big Mac", "nome");
  assert(calls.length === 1, "uma busca");
  assert(calls[0].includes("search_terms=big%20mac"), "espaço e nome limpos");
});

await check("quantidade e unidade saem do nome pesquisado", async () => {
  calls.length = 0;
  const res = response();
  await handler(request({ name: "1 colher de sopa de chia" }), res);
  assert(res.statusCode === 200, `status ${res.statusCode}`);
  assert(res.body.food.name === "Chia", "nome");
  assert(calls.length === 1, "uma busca");
  assert(calls[0].includes("search_terms=chia"), "só o alimento");
});

await check("sem resultado devolve 404", async () => {
  const res = response();
  await handler(request({ name: "sem dados" }), res);
  assert(res.statusCode === 404, `status ${res.statusCode}`);
  assert(res.body.found === false, "found");
});

await check("produto sem macros completos é ignorado", async () => {
  const res = response();
  await handler(request({ name: "incompleto" }), res);
  assert(res.statusCode === 404, `status ${res.statusCode}`);
  assert(res.body.found === false, "found");
});

globalThis.fetch = originalFetch;
if (failed) {
  console.error(`\n${failed} falha(s).`);
  process.exit(1);
}
console.log("\n9 verificações ok, 0 falha(s).");
