export const config = { maxDuration: 30 };

const SUPABASE_URL = process.env.SUPABASE_URL || "https://fmkmrrqseijcgcawqzoj.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || "sb_publishable__fM5rGKVNvICUJCoAJL6Jg_xZHtp9ES";
const SOURCE = "Open Food Facts";
const CACHE_TTL = 10 * 60_000;
const FOOD_CACHE_TTL = 180 * 24 * 60 * 60_000;
const RATE_LIMIT = 20;
const RATE_WINDOW = 60_000;
const CACHE = new Map();
const RATE = new Map();

function json(res, status, body) {
  res.status(status);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.send(JSON.stringify(body));
}

function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const IRREGULAR_PLURALS = {
  paes: "pao", feijoes: "feijao", ovos: "ovo", leites: "leite", carnes: "carne",
  nozes: "noz", hamburgueres: "hamburguer", sanduiches: "sanduiche", mcdonalds: "mcdonalds"
};
const QUERY_ALIASES = { bigmac: "big mac", "mc donalds": "mcdonalds" };

function canonicalFoodQuery(value) {
  let text = normalize(value)
    .replace(/^(?:\d+(?:[.,]\d+)?|um|uma|dois|duas|tres|quatro|cinco|seis|sete|oito|nove|dez)\s+/, "")
    .replace(/^(?:comi|almocei|jantei|tomei|lanchei|merendei|quero|queria|gostaria|anota|adiciona|registra)\s+/, "")
    .replace(/^\d+(?:[.,]\d+)?\s*(?:g|gramas?|ml|mililitros?|litros?|l)\s+(?:de\s+)?/, "")
    .replace(/^(?:colher(?:es)?\s+de\s+(?:sopa|cha)|colher(?:es)?|copos?|xicaras?|fatias?|gramas?|g|ml|mililitros?|litros?|l|pratos?|conchas?|scoops?|barras?|latas?|pacotes?|potes?|unidades?|porcoes?|doses?)\s+/, "")
    .replace(/\b(?:por favor|obrigado|obrigada|valeu|ok|beleza|certo|ta|hoje|agora|no almoco|no jantar|no cafe da manha|de manha|a tarde|a noite)\b/g, " ")
    .replace(/\b(?:um pouco de|um pouco|mais ou menos)\b/g, " ")
    .replace(/\s+\d+(?:[.,]\d+)?\s*(?:g|gramas?|ml)\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
  text = text.replace(/^(?:de|do|da|dos|das|com)\s+/, "").replace(/\s+(?:de|do|da|dos|das|com)$/, "").trim();
  text = text.replace(/\b([a-z]{3,})s\b/g, (word) => IRREGULAR_PLURALS[word] || word.slice(0, -1));
  return QUERY_ALIASES[text] || text;
}

function number(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function grams(value) {
  const match = String(value || "").match(/(\d+(?:[.,]\d+)?)\s*(kg|g|ml|l)\b/i);
  if (!match) return null;
  let amount = Number(match[1].replace(",", "."));
  if (!Number.isFinite(amount) || amount <= 0) return null;
  if (/^(?:kg|l)$/i.test(match[2])) amount *= 1000;
  return round1(amount);
}

function servingGrams(product) {
  const serving = number(product.serving_quantity);
  if (serving && serving > 0) return round1(serving);
  return grams(product.quantity) ?? grams(product.serving_size);
}

function rateLimited(userId) {
  const now = Date.now();
  const entry = RATE.get(userId);
  if (!entry || now - entry.start > RATE_WINDOW) {
    RATE.set(userId, { start: now, count: 1 });
    return false;
  }
  entry.count += 1;
  return entry.count > RATE_LIMIT;
}

function singular(name) {
  return name.replace(/\b([a-z]{3,})s\b/g, "$1");
}

function scoreProduct(product, query) {
  const name = normalize(product.product_name || product.generic_name || "");
  if (!name) return -1;
  const q = normalize(query);
  if (!q) return -1;
  if (name === q) return 100;
  if (name.includes(q)) return 80 + Math.min(10, q.length / 4) - Math.min(8, name.length / 60);
  const queryTokens = [...new Set(q.split(" ").filter((token) => token.length > 2))];
  const nameTokens = new Set(name.split(" "));
  if (!queryTokens.length) return -1;
  const overlap = queryTokens.filter((token) => nameTokens.has(token)).length;
  return (overlap / queryTokens.length) * 60 - Math.min(8, name.length / 60);
}

const PREPARED_WORDS = /\b(?:pate|pasta|molho|temperado|temperada|defumado|defumada|empanado|empanada|nuggets?|hamburguer|salsicha|linguica|bacon|salame)\b/;

function isPreparedMismatch(productName, query) {
  const name = normalize(productName);
  const q = normalize(query);
  return PREPARED_WORDS.test(name) && !PREPARED_WORDS.test(q);
}

function nutrition(product) {
  const n = product?.nutriments || {};
  let kcal = number(n["energy-kcal_100g"]);
  if (kcal == null) {
    const kj = number(n["energy-kj_100g"] ?? n.energy_100g);
    if (kj != null) kcal = kj / 4.184;
  }
  const protein = number(n.proteins_100g);
  const carbs = number(n.carbohydrates_100g);
  const fat = number(n.fat_100g);
  if ([kcal, protein, carbs, fat].some((value) => value == null) || kcal <= 0) return null;
  return { kcal: round1(kcal), protein: round1(protein), carbs: round1(carbs), fat: round1(fat) };
}

async function fetchProducts(query) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const url = new URL("https://world.openfoodfacts.org/cgi/search.pl");
    url.searchParams.set("search_terms", query);
    url.searchParams.set("search_simple", "1");
    url.searchParams.set("action", "process");
    url.searchParams.set("json", "1");
    url.searchParams.set("page_size", "50");
    url.search = url.search.replace(/\+/g, "%20");
    try {
      const upstream = await fetch(url, {
        headers: { Accept: "application/json", "User-Agent": "Viva/2.21.0 (https://viva-rouge-omega.vercel.app)" },
        signal: AbortSignal.timeout(6000)
      });
      if (upstream.ok) {
        const payload = await upstream.json().catch(() => null);
        const products = Array.isArray(payload?.products) ? payload.products : [];
        if (products.length) return products;
      }
    } catch {
      // A próxima tentativa cobre falhas transitórias do Open Food Facts.
    }
    if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 600));
  }
  return [];
}

async function searchOpenFoodFacts(name) {
  const queries = [...new Set([name, singular(name)])].filter(Boolean);
  let best = null;
  for (const query of queries) {
    const products = await fetchProducts(query);
    for (const product of products) {
      const values = nutrition(product);
      if (!values) continue;
      const productName = String(product.product_name || product.generic_name || "").trim();
      if (isPreparedMismatch(productName, query)) continue;
      const serving = servingGrams(product);
      const score = scoreProduct(product, query) + (serving ? 0.5 : 0);
      if (score <= 0) continue;
      if (!best || score > best.score) {
        const productName = String(product.product_name || product.generic_name || "").trim().slice(0, 120);
        const code = String(product.code || "").trim();
        best = {
          score,
          food: {
            code,
            name: productName,
            brand: String(product.brands || "").split(",")[0].trim().slice(0, 80),
            ...values,
            servingGrams: serving,
            source: SOURCE,
            url: code ? `https://world.openfoodfacts.org/product/${encodeURIComponent(code)}` : "https://world.openfoodfacts.org"
          }
        };
      }
    }
    if (best?.score >= 100) break;
  }
  return best?.food || null;
}

function supabaseHeaders(auth) {
  return { apikey: SUPABASE_KEY, Authorization: auth, "Content-Type": "application/json" };
}

async function readFoodCache(name, auth) {
  try {
    const url = `${SUPABASE_URL}/rest/v1/viva_foods?query=eq.${encodeURIComponent(name)}&select=query,food,found,source,source_url,updated_at&limit=1`;
    const response = await fetch(url, {
      headers: supabaseHeaders(auth),
      signal: AbortSignal.timeout(4000)
    });
    if (!response.ok) return null;
    const rows = await response.json().catch(() => null);
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row?.found) return null;
    const age = Date.now() - new Date(row.updated_at).getTime();
    return { row, stale: !Number.isFinite(age) || age > FOOD_CACHE_TTL };
  } catch {
    return null;
  }
}

async function saveFoodCache(name, food, auth) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/rpc/viva_save_food`, {
      method: "POST",
      headers: supabaseHeaders(auth),
      body: JSON.stringify({
        p_query: name,
        p_food: food,
        p_found: Boolean(food),
        p_source: food?.source || SOURCE,
        p_source_url: food?.url || null
      }),
      signal: AbortSignal.timeout(4000)
    });
  } catch {
    // A busca continua funcionando mesmo sem a tabela de cache.
  }
}

function touchFoodCache(name, auth) {
  fetch(`${SUPABASE_URL}/rest/v1/rpc/viva_touch_food`, {
    method: "POST",
    headers: supabaseHeaders(auth),
    body: JSON.stringify({ p_query: name }),
    signal: AbortSignal.timeout(4000)
  }).catch(() => {});
}

function cachedFood(row) {
  if (!row?.food || typeof row.food !== "object") return null;
  return {
    ...row.food,
    source: row.food.source || row.source || SOURCE,
    url: row.food.url || row.source_url || ""
  };
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return json(res, 204, {});
  if (req.method === "GET") return json(res, 200, { configured: true, source: SOURCE });
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
  const name = canonicalFoodQuery(body.name).slice(0, 120);
  if (name.length < 2) return json(res, 400, { error: "missing_name" });

  const key = name;
  const memory = CACHE.get(key);
  if (memory && Date.now() - memory.at < CACHE_TTL) return json(res, 200, { found: true, food: memory.food });

  const persisted = await readFoodCache(name, auth);
  if (persisted && !persisted.stale) {
    const food = cachedFood(persisted.row);
    if (food) {
      touchFoodCache(name, auth);
      return json(res, 200, { found: true, food });
    }
  }

  let food = null;
  let lookupFailed = false;
  try {
    food = await searchOpenFoodFacts(name);
  } catch {
    lookupFailed = true;
  }

  if (food) {
    CACHE.set(key, { at: Date.now(), food });
    if (CACHE.size > 200) {
      const oldest = [...CACHE.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) CACHE.delete(oldest[0]);
    }
    await saveFoodCache(name, food, auth);
    return json(res, 200, { found: true, food });
  }

  if (persisted?.row?.found) {
    const staleFood = cachedFood(persisted.row);
    if (staleFood) {
      touchFoodCache(name, auth);
      return json(res, 200, { found: true, food: staleFood });
    }
  }

  if (lookupFailed) return json(res, 502, { error: "lookup_unavailable" });
  return json(res, 404, { found: false });
}
