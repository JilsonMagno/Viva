import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

process.env.PORT = "12001";
const require = createRequire(import.meta.url);
const puppeteer = require("puppeteer-core");
const { server, reset, USER_A, USER_B } = require("./support/server.cjs");

const PORT = 12001;
const BASE = `http://127.0.0.1:${PORT}`;
const pageErrors = [];

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function equal(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message} (esperado ${JSON.stringify(expected)}, recebido ${JSON.stringify(actual)})`);
}

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  FAIL ${name}`);
    console.error(`       ${error.message}`);
  }
}

async function waitFor(fn, timeout = 10000, interval = 100) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    try {
      last = await fn();
      if (last) return last;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`timeout esperando condição${last instanceof Error ? `: ${last.message}` : ""}`);
}

const ymd = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const today = () => ymd(new Date());

function demoState(overrides = {}) {
  const yesterday = ymd(new Date(Date.now() - 86400000));
  return {
    version: 2,
    profile: { name: "Ana", age: 32, heightCm: 172, weightKg: 74.5, goal: "lose", aiEnabled: true, onboardedAt: new Date().toISOString() },
    targets: { kcal: 1970, protein: 119, carbs: 241, fat: 59, waterMl: 2600 },
    days: {},
    weights: [{ date: yesterday, kg: 75.0 }],
    chat: [],
    createdAt: new Date().toISOString(),
    ...overrides
  };
}

async function api(path, options) {
  const response = await fetch(BASE + path, options);
  return response;
}

async function resetAll() {
  await api("/__test/reset", { method: "POST" });
}

async function seed(data, user = "A") {
  await api("/__test/seed", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user, data })
  });
}

async function setConfig(patch) {
  await api("/__test/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch)
  });
}

async function getState() {
  return (await api("/__test/state")).json();
}

async function rowFor(userId) {
  const current = await getState();
  return current.rows.find((row) => row.user_id === userId) || null;
}

async function newPage() {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  return page;
}

async function login(page, user = "A") {
  await page.goto(`${BASE}/__test/login?user=${user}`, { waitUntil: "networkidle0" });
  await page.waitForFunction(
    () => !document.getElementById("screen-main").hidden || !document.getElementById("screen-onboarding").hidden,
    { timeout: 10000 }
  );
}

async function waitMain(page) {
  await page.waitForFunction(() => !document.getElementById("screen-main").hidden, { timeout: 10000 });
}

async function waitOnboarding(page) {
  await page.waitForFunction(() => !document.getElementById("screen-onboarding").hidden, { timeout: 10000 });
}

async function goView(page, view) {
  await page.evaluate((name) => {
    const tab = document.querySelector(`.tab[data-view="${name}"]`);
    const link = document.querySelector(`.side-link[data-view="${name}"]`);
    (tab && tab.offsetParent ? tab : link || tab).click();
  }, view);
  await page.waitForFunction((name) => !document.querySelector(`[data-view-panel="${name}"]`).hidden, { timeout: 5000 }, view);
}

async function send(page, text) {
  await goView(page, "viva");
  await page.click("#chat-input");
  await page.type("#chat-input", text);
  await page.click("#chat-send");
}

async function chatText(page) {
  return page.$eval("#chat-log", (element) => element.innerText);
}

async function waitChat(page, fragment, timeout = 10000) {
  await waitFor(async () => (await chatText(page)).includes(fragment), timeout);
}

async function textOf(page, selector) {
  return page.$eval(selector, (element) => element.innerText);
}

await new Promise((resolve) => server.listen(PORT, "127.0.0.1", resolve));
const browser = await puppeteer.launch({
  executablePath: "/usr/bin/chromium",
  args: ["--no-sandbox", "--disable-dev-shm-usage"]
});

console.log("\nTestes de ponta a ponta da Viva\n");

await check("1. login Google usa PKCE e cria sessão sem senha", async () => {
  await resetAll();
  const page = await newPage();
  await page.goto(`${BASE}/?sw=0`, { waitUntil: "networkidle0" });
  await page.waitForFunction(() => !document.getElementById("screen-login").hidden, { timeout: 5000 });
  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle0" }),
    page.click("#btn-google")
  ]);
  await waitOnboarding(page);
  const state = await getState();
  assert(state.lastAuthorize, "o app não chamou /authorize");
  equal(state.lastAuthorize.provider, "google", "provedor deve ser Google");
  equal(String(state.lastAuthorize.code_challenge_method).toLowerCase(), "s256", "PKCE deve usar S256");
  assert(state.lastAuthorize.code_challenge.length >= 43, "code_challenge curto demais");
  assert(state.lastAuthorize.redirect_to.startsWith(BASE), "redirect_to deve voltar para o app");
  assert(state.tokenGrants.includes("pkce"), "troca de código PKCE não aconteceu");
  assert(state.lastVerifier && state.lastVerifier !== state.lastAuthorize.code_challenge, "code_verifier inválido");
  const session = await page.evaluate(() => JSON.parse(localStorage.getItem("viva.session.v2")));
  assert(session.access_token && session.refresh_token, "sessão sem tokens");
  assert(session.expires_at > Date.now(), "sessão já expirada");
  assert(!page.url().includes("code="), "o código de autorização ficou na URL");
  await page.evaluate(async () => {
    if ("serviceWorker" in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map((registration) => registration.unregister()));
    }
    if (window.caches) {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
    }
  });
  await page.close();
});

await check("2. sessão expirada é renovada com refresh token", async () => {
  await resetAll();
  await seed(demoState());
  const page = await newPage();
  await login(page, "A");
  await waitMain(page);
  const before = await page.evaluate(() => JSON.parse(localStorage.getItem("viva.session.v2")).access_token);
  await api("/__test/expire", { method: "POST" });
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitMain(page);
  const state = await getState();
  assert(state.tokenGrants.includes("refresh_token"), "não houve refresh da sessão");
  const after = await page.evaluate(() => JSON.parse(localStorage.getItem("viva.session.v2")).access_token);
  assert(after && after !== before, "access token deveria ter mudado");
  await page.close();
});

await check("3. onboarding calcula as metas e salva na conta", async () => {
  await resetAll();
  const page = await newPage();
  await login(page, "B");
  await waitOnboarding(page);
  await page.type("#onb-name", "Bruno");
  await page.type("#onb-age", "30");
  await page.type("#onb-height", "180");
  await page.type("#onb-weight", "80");
  await page.click("#onb-goal-lose");
  await page.click("#onb-submit");
  await waitMain(page);
  const row = await rowFor(USER_B.id);
  assert(row, "a linha de Bruno não foi criada");
  equal(row.data.profile.name, "Bruno", "nome do perfil");
  equal(row.data.targets.kcal, 2150, "kcal alvo");
  equal(row.data.targets.protein, 128, "proteína alvo");
  equal(row.data.targets.carbs, 263, "carboidrato alvo");
  equal(row.data.targets.fat, 65, "gordura alvo");
  equal(row.data.targets.waterMl, 2800, "água alvo");
  assert((await textOf(page, "#greet-title")).includes("Bruno"), "saudação deveria citar Bruno");
  await page.close();
});

await check("4. refeição por texto é somada e persiste após recarregar", async () => {
  await resetAll();
  await seed(demoState());
  const page = await newPage();
  await login(page, "A");
  await waitMain(page);
  await send(page, "comi 2 ovos e um pão francês");
  await waitChat(page, "Total da refeição: 296 kcal");
  const row = await waitFor(async () => {
    const current = await rowFor(USER_A.id);
    return current && current.data.days[today()]?.meals?.length === 1 ? current : null;
  });
  const meal = row.data.days[today()].meals[0];
  equal(meal.items.length, 2, "itens da refeição");
  equal(meal.items[0].name, "Ovo cozido", "primeiro item");
  equal(meal.items[0].grams, 100, "gramas de ovo");
  equal(meal.items[1].name, "Pão francês", "segundo item");
  equal(meal.items[1].grams, 50, "gramas de pão");
  equal(meal.kcal, 296, "kcal da refeição");
  const list = await textOf(page, "#meal-list");
  assert(list.includes("Ovo cozido + Pão francês"), "lista deveria mostrar os dois alimentos");
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitMain(page);
  assert((await textOf(page, "#meal-list")).includes("Ovo cozido"), "refeição não persistiu");
  await page.close();
});

await check("5. água soma, desfaz e persiste", async () => {
  await resetAll();
  const base = demoState({ days: {} });
  await seed({ ...base, targets: { ...base.targets, waterMl: 2000 } });
  const page = await newPage();
  await login(page, "A");
  await waitMain(page);
  await goView(page, "hoje");
  await page.click("#btn-water-250");
  await page.click("#btn-water-250");
  await page.click("#btn-water-500");
  await waitFor(async () => (await textOf(page, "#water-total")) === "1.000");
  equal(await textOf(page, "#water-pct"), "50%", "percentual de água");
  equal(await page.$eval("#water-track", (el) => el.getAttribute("aria-valuenow")), "50", "aria-valuenow");
  await page.click("#btn-water-undo");
  await waitFor(async () => (await textOf(page, "#water-total")) === "500");
  await waitFor(async () => {
    const row = await rowFor(USER_A.id);
    return row && row.data.days[today()]?.waterMl === 500;
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitMain(page);
  equal(await textOf(page, "#water-total"), "500", "água após recarregar");
  await page.close();
});

await check("6. atividade por texto é calculada e pode ser removida", async () => {
  await resetAll();
  await seed(demoState({ days: {} }));
  const page = await newPage();
  await login(page, "A");
  await waitMain(page);
  await send(page, "corri 30 min");
  await waitChat(page, "Corrida por 30 min");
  await goView(page, "hoje");
  const row = await waitFor(async () => {
    const current = await rowFor(USER_A.id);
    return current && current.data.days[today()]?.activities?.length === 1 ? current : null;
  });
  const activity = row.data.days[today()].activities[0];
  equal(activity.name, "Corrida", "nome da atividade");
  equal(activity.minutes, 30, "minutos");
  equal(activity.kcal, 386, "kcal gastas");
  assert((await textOf(page, "#activity-list")).includes("Corrida"), "lista deveria mostrar a corrida");
  await page.click("[data-del-activity]");
  await waitFor(async () => {
    const current = await rowFor(USER_A.id);
    return current && current.data.days[today()].activities.length === 0;
  });
  assert((await textOf(page, "#activity-list")).includes("Sem atividade hoje"), "atividade não foi removida");
  await page.close();
});

await check("7. peso por texto atualiza o histórico e a diferença", async () => {
  await resetAll();
  await seed(demoState({ days: {} }));
  const page = await newPage();
  await login(page, "A");
  await waitMain(page);
  await send(page, "peso 74,5");
  await waitChat(page, "Peso registrado: 74,5 kg");
  await goView(page, "hoje");
  const row = await waitFor(async () => {
    const current = await rowFor(USER_A.id);
    return current && current.data.weights.length === 2 ? current : null;
  });
  equal(row.data.weights[row.data.weights.length - 1].kg, 74.5, "peso salvo");
  equal(await textOf(page, "#weight-latest"), "74,5", "peso exibido");
  equal(await textOf(page, "#weight-delta"), "-0,5 kg", "diferença de peso");
  equal(await page.$eval("#weight-delta", (el) => el.dataset.dir), "down", "direção da diferença");
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitMain(page);
  equal(await textOf(page, "#weight-latest"), "74,5", "peso após recarregar");
  await page.close();
});

await check("8. pergunta aberta envia texto e contexto vazio, e aceita answer/reply", async () => {
  await resetAll();
  await seed(demoState({ days: {} }));
  await setConfig({ aiAnswer: "Uma boa dieta varia os grupos alimentares." });
  const page = await newPage();
  await login(page, "A");
  await waitMain(page);
  const question = "o que é uma dieta equilibrada?";
  await send(page, question);
  await waitChat(page, "Uma boa dieta varia os grupos alimentares.");
  const state = await getState();
  equal(state.aiCalls, 1, "chamadas à IA");
  equal(state.aiQuestions[0], question, "pergunta enviada");
  const body = state.aiBodies[0];
  equal(body.question, question, "campo question");
  equal(body.message, question, "campo message");
  equal(JSON.stringify(body.context), "{}", "contexto deve ir vazio");
  equal(JSON.stringify(Object.keys(body)), JSON.stringify(["question", "message", "context"]), "corpo inesperado");
  const row = await rowFor(USER_A.id);
  equal(Object.keys(row.data.days).length, 0, "pergunta não deveria criar registros de refeição");
  await setConfig({ aiMode: "reply", aiAnswer: "Resposta no formato reply." });
  await send(page, "e no formato reply?");
  await waitChat(page, "Resposta no formato reply.");
  const replyState = await getState();
  equal(replyState.aiCalls, 2, "chamadas à IA com reply");
  equal(replyState.aiBodies[1].message, "e no formato reply?", "message no segundo envio");
  await page.close();
});

await check("9. IA desligada e falha da IA não quebram o app", async () => {
  await resetAll();
  const base = demoState({ days: {} });
  await seed({ ...base, profile: { ...base.profile, aiEnabled: false } });
  let page = await newPage();
  await login(page, "A");
  await waitMain(page);
  await send(page, "o que é uma dieta equilibrada?");
  await waitChat(page, "A IA está desligada");
  equal((await getState()).aiCalls, 0, "não deveria chamar a IA desligada");
  await page.close();

  await resetAll();
  await seed(demoState({ days: {} }));
  await setConfig({ aiMode: "fail" });
  page = await newPage();
  await login(page, "A");
  await waitMain(page);
  await send(page, "o que é uma dieta equilibrada?");
  await waitChat(page, "Não consegui falar com a IA");
  equal((await getState()).aiCalls, 1, "deveria tentar a IA uma vez");
  await send(page, "bebi 250 ml de água");
  await waitChat(page, "Anotei 250 ml de água");
  const row = await waitFor(async () => {
    const current = await rowFor(USER_A.id);
    return current && current.data.days[today()]?.waterMl === 250 ? current : null;
  });
  equal(row.data.days[today()].waterMl, 250, "o app deve continuar anotando após a falha da IA");
  await page.close();
});

await check("10. exportação gera um JSON completo dos dados", async () => {
  await resetAll();
  await seed(demoState());
  const page = await newPage();
  await page.evaluateOnNewDocument(() => {
    window.__blobs = [];
    const create = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob) => { window.__blobs.push(blob); return create(blob); };
    URL.revokeObjectURL = () => {};
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (this.download) { window.__download = { name: this.download, href: this.href }; return; }
      return click.call(this);
    };
  });
  await login(page, "A");
  await waitMain(page);
  await goView(page, "perfil");
  await page.click("#btn-export");
  const exported = await page.evaluate(async () => {
    const blob = window.__blobs[window.__blobs.length - 1];
    return { name: window.__download && window.__download.name, text: blob ? await blob.text() : null };
  });
  assert(exported.text, "exportação vazia");
  assert(/^viva-dados-\d{4}-\d{2}-\d{2}\.json$/.test(exported.name), `nome do arquivo inesperado: ${exported.name}`);
  const payload = JSON.parse(exported.text);
  equal(payload.app, "Viva", "app no JSON");
  equal(payload.data.profile.name, "Ana", "perfil exportado");
  equal(payload.data.targets.kcal, 1970, "metas exportadas");
  assert(payload.data.days && typeof payload.data.days === "object", "dias não exportados");
  await page.close();
});

await check("11. apagar todos os dados exige confirmação e limpa a conta", async () => {
  await resetAll();
  await seed(demoState());
  const page = await newPage();
  await login(page, "A");
  await waitMain(page);
  await goView(page, "perfil");
  await page.click("#btn-delete");
  assert((await textOf(page, "#delete-hint")).includes("5 segundos"), "primeiro toque deveria pedir confirmação");
  assert((await textOf(page, "#btn-delete")).includes("Toque de novo"), "botão deveria mudar de texto");
  await page.click("#btn-delete");
  await waitOnboarding(page);
  assert(!(await rowFor(USER_A.id)), "a linha da conta deveria ter sido apagada");
  await page.close();
});

await check("12. sair da conta revoga a sessão e volta ao login", async () => {
  await resetAll();
  await seed(demoState());
  const page = await newPage();
  await login(page, "A");
  await waitMain(page);
  const token = await page.evaluate(() => JSON.parse(localStorage.getItem("viva.session.v2")).access_token);
  await goView(page, "perfil");
  await page.click("#btn-logout");
  await page.waitForFunction(() => !document.getElementById("screen-login").hidden, { timeout: 5000 });
  equal(await page.evaluate(() => localStorage.getItem("viva.session.v2")), null, "sessão local deveria sumir");
  const state = await getState();
  assert(!state.tokens.includes(token), "token deveria ter sido revogado no servidor");
  await page.close();
});

await check("13. contas diferentes não misturam dados na interface", async () => {
  await resetAll();
  const meal = {
    id: "m1", at: new Date().toISOString(), label: "Almoço",
    items: [{ foodId: "ovo-cozido", name: "Ovo cozido", grams: 100, kcal: 145.7, p: 13.3, c: 0.6, f: 9.5 }],
    kcal: 146, p: 13.3, c: 0.6, f: 9.5
  };
  await seed(demoState({ days: { [today()]: { meals: [meal], waterMl: 0, activities: [] } } }), "A");
  await seed(demoState({ profile: { ...demoState().profile, name: "Bruno" }, days: {} }), "B");
  const page = await newPage();
  await login(page, "A");
  await waitMain(page);
  assert((await textOf(page, "#greet-title")).includes("Ana"), "saudação de Ana");
  await goView(page, "hoje");
  assert((await textOf(page, "#meal-list")).includes("Ovo cozido"), "refeição de Ana");
  await login(page, "B");
  await waitMain(page);
  assert((await textOf(page, "#greet-title")).includes("Bruno"), "saudação de Bruno");
  await goView(page, "hoje");
  assert(!(await textOf(page, "#meal-list")).includes("Ovo cozido"), "Bruno não deveria ver a refeição de Ana");
  const rowA = await rowFor(USER_A.id);
  equal(rowA.data.days[today()].meals.length, 1, "dados de Ana continuam intactos");
  await page.close();
});

await check("14. links diretos (#diario, #viva) abrem a aba certa", async () => {
  await resetAll();
  await seed(demoState());
  const page = await newPage();
  await login(page, "A");
  await waitMain(page);
  await page.evaluate(() => { location.hash = "#diario"; });
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitMain(page);
  await page.waitForFunction(() => !document.getElementById("view-diario").hidden, { timeout: 5000 });
  equal(await page.$eval('.tab[data-view="diario"]', (el) => el.getAttribute("aria-current")), "page", "aba Diário ativa");
  await page.evaluate(() => { location.hash = "#viva"; });
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitMain(page);
  await page.waitForFunction(() => !document.getElementById("view-viva").hidden, { timeout: 5000 });
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitMain(page);
  await page.waitForFunction(() => !document.getElementById("view-viva").hidden, { timeout: 5000 });
  await page.close();
});

await check("15. manifest, ícones e service worker estão funcionando", async () => {
  const manifestResponse = await fetch(`${BASE}/manifest.webmanifest`);
  equal(manifestResponse.status, 200, "status do manifest");
  const manifest = await manifestResponse.json();
  assert(manifest.name.includes("Viva"), "nome do manifest");
  const sizes = manifest.icons.map((icon) => icon.sizes);
  assert(sizes.includes("192x192") && sizes.includes("512x512"), "ícones 192 e 512");
  for (const file of ["icon-192.png", "icon-512.png"]) {
    const buffer = Buffer.from(await (await fetch(`${BASE}/${file}`)).arrayBuffer());
    assert(buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47, `${file} não é PNG`);
  }
  const swSource = await (await fetch(`${BASE}/sw.js`)).text();
  assert(swSource.includes('url.pathname.startsWith("/sb/")'), "o service worker não deve interceptar a API");
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  const registration = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    return { script: reg.active && reg.active.scriptURL, scope: reg.scope };
  });
  assert(registration.script.endsWith("/sw.js"), `service worker inesperado: ${registration.script}`);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, { timeout: 10000 });
  await context.close();
});

await check("16. interface mobile não vaza na horizontal e tem nomes acessíveis", async () => {
  await resetAll();
  await seed(demoState());
  const page = await newPage();
  await login(page, "A");
  await waitMain(page);
  await goView(page, "hoje");
  const audit = await page.evaluate(() => {
    const nameless = [...document.querySelectorAll("button")].filter((button) =>
      !(button.textContent.trim() || button.getAttribute("aria-label") || button.getAttribute("title"))
    ).map((button) => button.id || button.outerHTML.slice(0, 80));
    const unlabeled = [...document.querySelectorAll("input, select, textarea")].filter((field) =>
      !(field.labels && field.labels.length) && !field.getAttribute("aria-label") && !field.getAttribute("aria-labelledby")
    ).map((field) => field.id || field.name);
    return {
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth,
      nameless,
      unlabeled,
      lang: document.documentElement.lang,
      viewport: document.querySelector('meta[name="viewport"]')?.content || "",
      manifest: !!document.querySelector('link[rel="manifest"]')
    };
  });
  assert(audit.scrollWidth <= audit.innerWidth, `overflow horizontal: ${audit.scrollWidth} > ${audit.innerWidth}`);
  equal(audit.nameless.length, 0, `botões sem nome acessível: ${audit.nameless.join(", ")}`);
  equal(audit.unlabeled.length, 0, `campos sem rótulo: ${audit.unlabeled.join(", ")}`);
  equal(audit.lang, "pt-BR", "idioma do documento");
  assert(audit.viewport.includes("width=device-width"), "viewport mobile");
  assert(audit.manifest, "link do manifest");
  await page.close();
});

await check("17. falha de rede ao salvar mantém os dados e tenta de novo", async () => {
  await resetAll();
  await seed(demoState({ days: {} }));
  const page = await newPage();
  await login(page, "A");
  await waitMain(page);
  await goView(page, "hoje");
  let aborted = false;
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    if (!aborted && request.method() === "POST" && request.url().includes("/rest/v1/viva_data")) {
      aborted = true;
      request.abort("failed");
    } else {
      request.continue();
    }
  });
  await page.click("#btn-water-250");
  await waitFor(async () => (await textOf(page, "#sync-status")) === "Não salvou", 8000);
  await page.click("#btn-water-250");
  await waitFor(async () => (await textOf(page, "#sync-status")) === "Salvo", 8000);
  const row = await waitFor(async () => {
    const current = await rowFor(USER_A.id);
    return current && current.data.days[today()]?.waterMl === 500 ? current : null;
  });
  equal(row.data.days[today()].waterMl, 500, "as duas doses deveriam ser salvas juntas");
  equal(await textOf(page, "#water-total"), "500", "total após recuperação");
  await page.close();
});

await check("18. configuração ausente mostra a tela de aviso", async () => {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    if (request.url().endsWith("/config.js")) {
      request.respond({ status: 200, contentType: "application/javascript", body: 'window.VIVA_CONFIG={SUPABASE_URL:"",SUPABASE_ANON_KEY:"",AI_FUNCTION:"assistente"};' });
    } else {
      request.continue();
    }
  });
  await page.goto(`${BASE}/?sw=0`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !document.getElementById("screen-config").hidden, { timeout: 5000 });
  assert((await textOf(page, "#screen-config")).length > 0, "tela de configuração vazia");
  assert(await page.$eval("#screen-login", (el) => el.hidden), "login não deveria aparecer sem configuração");
  await context.close();
});

await check("19. login visitante entra e cria dados no Supabase", async () => {
  await resetAll();
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(`${BASE}/?sw=0`, { waitUntil: "domcontentloaded", timeout: 15000 });
  await page.waitForFunction(() => !document.getElementById("screen-login").hidden, { timeout: 5000 });
  await page.click("#btn-anon");
  await waitOnboarding(page);
  await page.type("#onb-name", "Visitante");
  await page.type("#onb-age", "30");
  await page.type("#onb-height", "170");
  await page.type("#onb-weight", "70");
  await page.click("#onb-submit");
  await waitMain(page);
  assert((await textOf(page, "#greet-title")).includes("Visitante"), "saudação deveria citar Visitante");
  const state = await getState();
  equal(state.rows.length, 1, "deveria existir uma linha para o visitante");
  equal(state.rows[0].data.profile.name, "Visitante", "nome do perfil visitante");
  await context.close();
});

await check("20. nenhuma exceção de página durante os testes", async () => {
  assert(pageErrors.length === 0, pageErrors.join(" | "));
});

await browser.close();
await new Promise((resolve) => server.close(resolve));
console.log(`\n${passed} verificações ok, ${failed} falha(s).\n`);
process.exit(failed ? 1 : 0);
