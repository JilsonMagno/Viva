const USER_AGENT = "Viva/2.15.7 (+https://viva-rouge-omega.vercel.app)";
const CACHE = new Map();
const CACHE_TTL = 10 * 60 * 1000;
const MAX_RESULTS = 5;
const TIMEOUT = 7000;

const HEALTH = /(saude|saúde|nutri|dieta|aliment|exerc|treino|peso|emagrec|musculo|músculo|vitamina|proteina|proteína|creatina|suplement|doenca|doença|sono|glicose|colesterol|hipertens|diabet|gesta|gravidez|medic|remédio|remedio|caloria|gordura|fibra|agua|água|health|nutrition|diet|exercise|weight|muscle|vitamin|protein|creatine|supplement|disease|sleep|glucose|cholesterol|diabetes|pregnan|calorie|fat|fiber)/i;

export function cleanQuery(text) {
  return String(text || "")
    .replace(/\bo\s+que\s+[eé](?=\s|$)/gi, " ")
    .replace(/\bquais?\s+(?:são|sao|é|e)(?=\s|$)/gi, " ")
    .replace(/\bqual\s+(?:é|e)(?=\s|$)/gi, " ")
    .replace(/\b(pesquise|pesquisar|busque|buscar|procure|procurar|me\s+fale|fale\s+sobre|conte\s+sobre|explique|explica|como|o\s+que\s+[eé]|quais?\s+(são|sao)?|qual\s+(é|e)?|quantas?|quantos?|quanto|sobre|quero|queria|gostaria|preciso|posso|pode|devo|comprar|tomar|usar|comer|beber|vale\s+a\s+pena|faz\s+mal|faz\s+bem|benefícios|beneficios|riscos|segurança|seguranca|saber|conhecer|entender|aprender|dica|dicas|informação|informacao|informações|informacoes|ajuda|ajudar|falar|fale|dizer|diga|conte|contar|explicar|explicação|explicacao|interessa|interesse|onde|encontrar|preço|preco|me|mim|eu|você|voce|vc|por\s+favor|obrigado|obrigada)\b/gi, " ")
    .replace(/\b(a|o|as|os|um|uma|uns|umas|de|da|do|das|dos|e|em|no|na|nos|nas|para|por|com|sem|que|se|é|tem|ter|faz|fazer)\b/gi, " ")
    .replace(/[?!]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

const TERM_MAP = [
  [/\bcreatina\b/gi, "creatine"],
  [/\bproteínas?\b/gi, "protein"],
  [/\bvitaminas?\b/gi, "vitamin"],
  [/\bdietas?\b/gi, "diet"],
  [/\bemagrecimento\b/gi, "weight loss"],
  [/\bemagrecer\b/gi, "weight loss"],
  [/\bexercícios?\b/gi, "exercise"],
  [/\bjejum\b/gi, "fasting"],
  [/\bsuplementos?\b/gi, "supplement"],
  [/\bágua\b/gi, "water"],
  [/\bsono\b/gi, "sleep"],
  [/\bgordura\b/gi, "fat"],
  [/\bcalorias?\b/gi, "calorie"],
  [/\bwhey\b/gi, "whey protein"]
];

function translateQuery(text) {
  return TERM_MAP.reduce((value, [pattern, replacement]) => value.replace(pattern, replacement), text);
}

function decode(text) {
  return String(text || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function clip(text, max = 420) {
  const value = decode(text);
  return value.length > max ? `${value.slice(0, max - 1).trim()}…` : value;
}

async function getJson(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function getText(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/xml,text/xml" },
    signal: AbortSignal.timeout(TIMEOUT)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

async function tavily(query) {
  const key = String(process.env.TAVILY_API_KEY || "").trim();
  if (!key) return null;
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(TIMEOUT),
    body: JSON.stringify({
      api_key: key,
      query,
      search_depth: "basic",
      max_results: MAX_RESULTS,
      include_answer: false,
      include_raw_content: false
    })
  });
  if (!res.ok) throw new Error(`Tavily HTTP ${res.status}`);
  const data = await res.json();
  return (data.results || []).map((item) => ({
    title: clip(item.title, 160),
    url: String(item.url || ""),
    snippet: clip(item.content || item.snippet || ""),
    source: "Tavily"
  }));
}

function normalizeText(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

export function meaningfulTerms(query) {
  return normalizeText(query)
    .split(/\s+/)
    .filter((term) => term.length >= 3 && !/^\d+$/.test(term));
}

export function titleScore(item, terms) {
  const title = normalizeText(item.title);
  return terms.filter((term) => title.includes(term)).length;
}

async function wikipedia(query) {
  const search = await getJson(
    `https://pt.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&utf8=1&srlimit=5`
  );
  const hits = search?.query?.search || [];
  const pages = await Promise.all(hits.map(async (hit) => {
    try {
      const summary = await getJson(
        `https://pt.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(hit.title)}`
      );
      return {
        title: clip(summary.title || hit.title, 160),
        url: summary.content_urls?.desktop?.page || `https://pt.wikipedia.org/wiki/${encodeURIComponent(hit.title)}`,
        snippet: clip(summary.extract || hit.snippet),
        source: "Wikipedia"
      };
    } catch {
      return null;
    }
  }));
  const terms = meaningfulTerms(query);
  const scored = pages
    .filter(Boolean)
    .map((page) => ({ page, score: titleScore(page, terms) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);
  const exact = scored.filter((item) => item.score >= Math.min(2, terms.length));
  return (exact.length ? exact : scored).slice(0, 3).map((item) => item.page);
}

async function pubmed(query) {
  if (!HEALTH.test(query)) return [];
  const search = await getJson(
    `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(query)}&retmode=json&retmax=3&sort=relevance`
  );
  const ids = search?.esearchresult?.idlist || [];
  if (!ids.length) return [];
  const xml = await getText(
    `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=${ids.join(",")}&retmode=xml`
  );
  const results = [];
  for (const block of xml.matchAll(/<PubmedArticle>([\s\S]*?)<\/PubmedArticle>/g)) {
    const article = block[1];
    const id = article.match(/<PMID[^>]*>(\d+)<\/PMID>/)?.[1] || "";
    const title = clip(article.match(/<ArticleTitle>([\s\S]*?)<\/ArticleTitle>/)?.[1], 180);
    const abstract = clip(
      [...article.matchAll(/<AbstractText[^>]*>([\s\S]*?)<\/AbstractText>/g)].map((part) => part[1]).join(" "),
      600
    );
    const journal = clip(article.match(/<Title>([\s\S]*?)<\/Title>/)?.[1], 80);
    if (!title || !id) continue;
    results.push({
      title,
      url: `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
      snippet: `${journal ? `${journal}. ` : ""}${abstract || "Resumo não disponível."}`,
      source: "PubMed"
    });
  }
  return results;
}

export async function research(query) {
  const value = cleanQuery(query);
  if (!value) return { results: [], provider: "none" };
  const cached = CACHE.get(value.toLowerCase());
  if (cached && Date.now() - cached.at < CACHE_TTL) return cached.data;

  let results = [];
  let provider = "wikipedia+pubmed";
  try {
    const web = await tavily(value);
    if (web?.length) {
      results = web;
      provider = "tavily";
    }
  } catch {
    // Sem chave ou provedor indisponível: segue para as fontes públicas.
  }
  if (!results.length) {
    const [wiki, papers] = await Promise.all([
      wikipedia(value).catch(() => []),
      pubmed(translateQuery(value)).catch(() => [])
    ]);
    results = [...wiki, ...papers];
  }

  const seen = new Set();
  results = results
    .filter((item) => item && item.url && item.title && !seen.has(item.url) && seen.add(item.url))
    .slice(0, MAX_RESULTS);
  const data = { results, provider: results.length ? provider : "none" };
  CACHE.set(value.toLowerCase(), { at: Date.now(), data });
  if (CACHE.size > 200) {
    const now = Date.now();
    for (const [key, entry] of CACHE) if (now - entry.at > CACHE_TTL) CACHE.delete(key);
  }
  return data;
}
