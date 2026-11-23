import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

process.env.PORT = "12001";
const require = createRequire(import.meta.url);
const puppeteer = require("puppeteer-core");
const { server, reset, USER_A, USER_B } = require("./support/server.cjs");

const PORT = 12001;
const BASE = `http://127.0.0.1:${PORT}`;
const mealCases = JSON.parse(fs.readFileSync(fileURLToPath(new URL("./fixtures/meal-cases.json", import.meta.url)), "utf8"));
const pageErrors = [];
const dishPng = "/tmp/viva-dish-test.png";
fs.writeFileSync(
  dishPng,
  Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z4p8AAAAASUVORK5CYII=", "base64")
);

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

await check("4b. refeição entende plural e não confunde 'colher de sopa' com sopa", async () => {
  await resetAll();
  await seed(demoState());
  const page = await newPage();
  await login(page, "A");
  await waitMain(page);
  await send(page, "Duas bananas com 2 colher de sopa de aveia");
  await waitChat(page, "Total da refeição: 256 kcal");
  const row = await waitFor(async () => {
    const current = await rowFor(USER_A.id);
    return current && current.data.days[today()]?.meals?.length === 1 ? current : null;
  });
  const meal = row.data.days[today()].meals[0];
  equal(meal.items.length, 2, "itens da refeição");
  equal(meal.items[0].name, "Banana", "primeiro item");
  equal(meal.items[0].grams, 140, "gramas de banana");
  equal(meal.items[1].name, "Aveia em flocos", "segundo item");
  equal(meal.items[1].grams, 30, "gramas de aveia");
  assert(!meal.items.some((item) => /sopa/i.test(item.name)), "não deveria registrar sopa");
  assert(Math.abs(meal.kcal - 256) < 0.6, `kcal ${meal.kcal}`);
  await page.close();
});

await check("4c. colheres escalam a quantidade e as calorias", async () => {
  await resetAll();
  await seed(demoState());
  const page = await newPage();
  await login(page, "A");
  await waitMain(page);
  await send(page, "4 colheres de aveia");
  await waitChat(page, "Total da refeição: 236 kcal");
  await send(page, "1 colher de aveia");
  await waitChat(page, "Total da refeição: 59 kcal");
  const row = await waitFor(async () => {
    const current = await rowFor(USER_A.id);
    return current && current.data.days[today()]?.meals?.length === 2 ? current : null;
  });
  const meals = row.data.days[today()].meals;
  equal(meals[0].items[0].grams, 60, "4 colheres = 60 g");
  equal(meals[0].kcal, 236, "4 colheres = 236 kcal");
  equal(meals[1].items[0].grams, 15, "1 colher = 15 g");
  equal(meals[1].kcal, 59, "1 colher = 59 kcal");
  await page.close();
});

await check("4d. nome fora da tabela é buscado em base pública", async () => {
  await resetAll();
  await seed(demoState());
  const page = await newPage();
  await login(page, "A");
  await waitMain(page);
  await send(page, "2 ovos e 100g de esfiha");
  await waitChat(page, "Esfiha de carne");
  const row = await waitFor(async () => {
    const current = await rowFor(USER_A.id);
    return current && current.data.days[today()]?.meals?.length === 1 ? current : null;
  });
  const meal = row.data.days[today()].meals[0];
  equal(meal.items.length, 2, "itens conhecido + pesquisado");
  equal(meal.items[0].name, "Ovo cozido", "alimento da tabela");
  equal(meal.items[0].grams, 100, "gramas do ovo");
  equal(meal.items[1].name, "Esfiha de carne", "nome retornado");
  equal(meal.items[1].grams, 100, "gramas");
  equal(meal.items[1].kcal, 250, "kcal");
  equal(meal.items[1].source, "Open Food Facts", "fonte");
  const state = await getState();
  equal(state.foodCalls, 1, "consulta feita");
  equal(state.foodQueries[0], "esfiha", "nome consultado");
  await page.close();
});

await check("4f. uma unidade usa o peso da porção encontrada", async () => {
  await resetAll();
  await seed(demoState());
  const page = await newPage();
  await login(page, "A");
  await waitMain(page);
  await send(page, "1 esfiha");
  await waitChat(page, "Total da refeição: 300 kcal");
  const row = await waitFor(async () => {
    const current = await rowFor(USER_A.id);
    return current && current.data.days[today()]?.meals?.length === 1 ? current : null;
  });
  const item = row.data.days[today()].meals[0].items[0];
  equal(item.grams, 120, "1 unidade = 120 g da porção");
  equal(item.kcal, 300, "kcal da porção");
  await page.close();
});

await check("4g. padroniza o nome antes de pesquisar", async () => {
  await resetAll();
  await seed(demoState());
  const page = await newPage();
  await login(page, "A");
  await waitMain(page);
  const inputs = ["1 Big Mac", "2 esfihas de carne", "1 colher de sopa de chia"];
  for (let index = 0; index < inputs.length; index += 1) {
    await send(page, inputs[index]);
    await waitFor(async () => (await getState()).foodCalls === index + 1);
  }
  const state = await getState();
  equal(state.foodQueries[0], "big mac", "nome e espaço");
  equal(state.foodQueries[1], "esfiha de carne", "plural e preposição");
  equal(state.foodQueries[2], "chia", "quantidade e unidade fora do nome");
  await page.close();
});

await check("4h. registra treino com músculos e intensidade na tela principal", async () => {
  await resetAll();
  await seed(demoState({ days: {} }));
  const page = await newPage();
  await login(page, "A");
  await waitMain(page);
  await page.$eval("#home-workout-add", (el) => el.click());
  await page.waitForFunction(() => !document.querySelector('[data-view-panel="atividades"]').hidden);
  await page.type("#workout-name", "Peito e tríceps");
  await page.select("#workout-intensity", "Médio");
  await page.$eval("#workout-minutes", (el) => { el.value = "45"; });
  await page.click("#workout-submit");
  const first = await waitFor(async () => {
    const current = await rowFor(USER_A.id);
    return current && current.data.days[today()]?.activities?.length === 1 ? current : null;
  });
  const workout = first.data.days[today()].activities[0];
  equal(workout.name, "Musculação", "atividade base");
  equal(workout.workout, "Peito e Tríceps", "músculos");
  equal(workout.intensity, "Médio", "intensidade");
  equal(workout.minutes, 45, "minutos");
  equal(workout.met, 6, "MET do treino médio");
  assert((await textOf(page, "#activity-list")).includes("Peito e Tríceps"), "lista deveria mostrar o treino");

  await send(page, "costa e bíceps intenso 50 min");
  const second = await waitFor(async () => {
    const current = await rowFor(USER_A.id);
    return current && current.data.days[today()]?.activities?.length === 2 ? current : null;
  });
  const strong = second.data.days[today()].activities[1];
  equal(strong.workout, "Costas e Bíceps", "músculos pelo assistente");
  equal(strong.intensity, "Intenso", "intensidade pelo assistente");
  equal(strong.minutes, 50, "minutos pelo assistente");
  equal(strong.met, 7.5, "MET do treino intenso");

  await send(page, "fiz peito de frango");
  const afterChicken = await rowFor(USER_A.id);
  equal(afterChicken.data.days[today()].activities.length, 2, "frango não deve virar treino");

  await goView(page, "hoje");
  const home = await textOf(page, "#home-workout-list");
  assert(home.includes("Peito e Tríceps") && home.includes("Médio"), "treino médio na tela principal");
  assert(home.includes("Costas e Bíceps") && home.includes("Intenso"), "treino intenso na tela principal");
  equal(await textOf(page, "#home-workout-count"), "2 treinos", "contador de treinos");
  await page.close();
});

await check("4i. sugere compras dentro do orçamento e responde no assistente", async () => {
  await resetAll();
  await seed(demoState());
  const page = await newPage();
  await login(page, "A");
  await waitMain(page);
  await goView(page, "atividades");
  await page.$eval("#budget-value", (el) => { el.value = "150"; });
  await page.$eval("#budget-form", (form) => form.requestSubmit());
  await waitFor(async () => (await textOf(page, "#budget-result")).includes("R$"));
  const result = await textOf(page, "#budget-result");
  assert(result.includes("proteína") && result.includes("calorias"), "resultado deveria mostrar cobertura das metas");
  const itemCount = await page.$$eval("#budget-result .budget-item", (items) => items.length);
  assert(itemCount >= 4, `esperava uma cesta com vários itens, recebi ${itemCount}`);
  assert(/Frango|Ovos|Arroz|Feijão/.test(result), "cesta deveria ter alimentos básicos");

  await send(page, "tenho apenas 150 reais, o que poderia comprar para chegar o mais perto da meta?");
  await waitChat(page, "Sugestão de compras");
  const chat = await chatText(page);
  assert(chat.includes("R$ 150,00"), "resposta deveria citar o orçamento");
  assert(chat.includes("proteína") && chat.includes("calorias"), "resposta deveria citar as metas");

  await send(page, "o que posso comprar?");
  await waitChat(page, "Quanto você tem para gastar");
  await page.$eval("#budget-value", (el) => { el.value = "30"; });
  await page.$eval("#budget-form", (form) => form.requestSubmit());
  await waitFor(async () => (await textOf(page, "#budget-result")).includes("Cobre"));
  const low = await textOf(page, "#budget-result");
  assert(low.includes("Cobre") && low.includes("%"), "orçamento baixo deveria mostrar cobertura parcial");
  await page.close();
});

await check("4j. edita quantidade e exclui alimento da refeição", async () => {
  await resetAll();
  await seed(demoState());
  const page = await newPage();
  await login(page, "A");
  await waitMain(page);
  await send(page, "comi 2 ovos e um pão francês");
  await waitChat(page, "Total da refeição: 296 kcal");
  await goView(page, "alimentacao");
  await page.$eval("[data-edit-meal]", (el) => el.click());
  await page.waitForSelector(".meal-edit");
  await page.$eval('[data-meal-item-grams="0"]', (el) => { el.value = "150"; });
  await page.$eval("[data-meal-edit]", (form) => form.requestSubmit());
  const edited = await waitFor(async () => {
    const current = await rowFor(USER_A.id);
    const meal = current?.data.days[today()]?.meals?.[0];
    return meal?.items?.[0]?.grams === 150 ? meal : null;
  });
  equal(edited.items.length, 2, "edição mantém os dois alimentos");
  assert(Math.abs(edited.kcal - 368) <= 1, `kcal após editar: ${edited.kcal}`);

  await page.$eval("[data-edit-meal]", (el) => el.click());
  await page.waitForSelector(".meal-edit");
  await page.$eval('[data-del-meal-item="1"]', (el) => el.click());
  const afterDelete = await waitFor(async () => {
    const current = await rowFor(USER_A.id);
    const meal = current?.data.days[today()]?.meals?.[0];
    return meal?.items?.length === 1 ? meal : null;
  });
  equal(afterDelete.items[0].name, "Ovo cozido", "sobrou o ovo");
  assert(!(await textOf(page, "#meal-list")).includes("Pão francês"), "pão deveria ter saído da lista");
  await page.close();
});

await check("4e. sem dados públicos, não inventa valores", async () => {
  await resetAll();
  await setConfig({ foodMode: "notfound" });
  await seed(demoState());
  const page = await newPage();
  await login(page, "A");
  await waitMain(page);
  await send(page, "100g de esfiha");
  await waitChat(page, "Não encontrei dados confiáveis");
  const row = await rowFor(USER_A.id);
  equal((row?.data.days[today()]?.meals || []).length, 0, "não deveria anotar");
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
  await goView(page, "atividades");
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
  await page.select("#sim-activity", "0");
  await page.select("#sim-intensity", "1");
  await page.$eval("#sim-minutes", (el) => {
    el.value = "45";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await waitFor(async () => (await textOf(page, "#sim-kcal")).includes("kcal"));
  assert((await textOf(page, "#sim-detail")).includes("75 kg"), "simulador deveria usar o peso mais recente");
  await page.click("#sim-add");
  const simulated = await waitFor(async () => {
    const current = await rowFor(USER_A.id);
    const list = current?.data.days[today()]?.activities || [];
    return list.length === 1 && list[0].name === "Corrida" ? current : null;
  });
  const simulatedActivity = simulated.data.days[today()].activities[0];
  equal(simulatedActivity.minutes, 45, "minutos do simulador");
  equal(simulatedActivity.intensity, "Moderada", "intensidade do simulador");
  assert((await textOf(page, "#activity-list")).includes("45 min"), "lista deveria mostrar a atividade simulada");
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

await check("8. pergunta aberta envia perfil, metas e histórico do usuário", async () => {
  await resetAll();
  const day = today();
  await seed(demoState({
    days: {
      [day]: {
        meals: [{
          id: "ctx-meal",
          at: new Date().toISOString(),
          label: "Almoço",
          kcal: 296,
          p: 19.1,
          c: 29.9,
          f: 12.6,
          items: [{ name: "Ovo cozido", grams: 100, kcal: 145.7, p: 13.3, c: 0.6, f: 9.5 }]
        }],
        waterMl: 500,
        activities: [{ id: "ctx-act", at: new Date().toISOString(), name: "Caminhada", minutes: 30, kcal: 150, met: 3.5 }],
        weightKg: 74.2
      }
    }
  }));
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
  equal(body.search, true, "pesquisa web ligada por padrão");
  assert(body.context && typeof body.context === "object", "contexto deve ser um objeto");
  equal(body.context.profile.name, "Ana", "nome no contexto");
  equal(body.context.profile.goal, "lose", "objetivo no contexto");
  equal(body.context.targets.kcal, 1970, "meta de kcal no contexto");
  equal(body.context.targets.protein, 119, "meta de proteína no contexto");
  equal(body.context.today.meals[0].label, "Almoço", "refeição no contexto");
  equal(body.context.today.meals[0].items[0].name, "Ovo cozido", "item no contexto");
  equal(body.context.today.waterMl, 500, "água no contexto");
  equal(body.context.today.activities[0].minutes, 30, "atividade no contexto");
  equal(body.context.summary.todayKcal, 296, "resumo de kcal no contexto");
  equal(body.context.summary.todayProtein, 19.1, "resumo de proteína no contexto");
  equal(body.context.today.weightKg, 74.2, "peso do dia no contexto");
  equal(body.context.weights.length, 1, "histórico de peso no contexto");
  assert(Array.isArray(body.context.dailyHistory) && body.context.dailyHistory.length === 1, "histórico diário no contexto");
  assert(JSON.stringify(body.context).length <= 20000, "contexto deve respeitar o limite");
  equal(JSON.stringify(Object.keys(body)), JSON.stringify(["question", "message", "context", "search"]), "corpo inesperado");
  const row = await rowFor(USER_A.id);
  equal(Object.keys(row.data.days).length, 1, "pergunta não deveria criar outro dia");
  await setConfig({ aiMode: "reply", aiAnswer: "Resposta no formato reply." });
  await send(page, "e no formato reply?");
  await waitChat(page, "Resposta no formato reply.");
  const replyState = await getState();
  equal(replyState.aiCalls, 2, "chamadas à IA com reply");
  equal(replyState.aiBodies[1].message, "e no formato reply?", "message no segundo envio");
  assert(replyState.aiBodies[1].context.profile.name === "Ana", "contexto no segundo envio");
  await page.close();
});

await check("8b. texto livre, sem pergunta, também vai para a IA", async () => {
  await resetAll();
  await seed(demoState({ days: {} }));
  await setConfig({ aiAnswer: "A creatina é um suplemento; converse com um profissional antes de usar." });
  const page = await newPage();
  await login(page, "A");
  await waitMain(page);
  await send(page, "quero comprar creatina");
  await waitChat(page, "A creatina é um suplemento");
  const state = await getState();
  equal(state.aiCalls, 1, "texto livre deveria chamar a IA");
  equal(state.aiBodies[0].search, true, "pesquisa ligada");
  assert(!(await chatText(page)).includes("Quanto você tem para gastar"), "não deveria cair no orçamento");
  await page.$eval("#chat-search", (el) => { el.checked = false; });
  await send(page, "e sem pesquisa?");
  const off = await waitFor(async () => {
    const current = await getState();
    return current.aiCalls === 2 ? current : null;
  });
  equal(off.aiBodies[1].search, false, "pesquisa desligada no segundo envio");
  await page.close();
});

await check("8c. resposta de pesquisa mostra as fontes consultadas", async () => {
  await resetAll();
  await seed(demoState());
  await setConfig({
    aiEndpoint: "/api/ai",
    aiServer: { configured: true, provider: "openai", model: "gpt-4o-mini", vision: true },
    aiSources: [{ title: "Creatina", url: "https://pt.wikipedia.org/wiki/Creatina", source: "Wikipedia" }]
  });
  const page = await newPage();
  await login(page, "A");
  await waitMain(page);
  await send(page, "pesquise sobre creatina");
  await waitChat(page, "Fontes consultadas");
  const chat = await chatText(page);
  assert(chat.includes("Creatina") && chat.includes("https://pt.wikipedia.org/wiki/Creatina"), "fonte deveria aparecer no chat");
  await page.close();
});

await check("8d. conversa livre sobre alimento não vira registro", async () => {
  await resetAll();
  await seed(demoState({ days: {} }));
  await setConfig({ aiAnswer: "O arroz integral é uma boa fonte de carboidratos e fibras." });
  const page = await newPage();
  await login(page, "A");
  await waitMain(page);
  await send(page, "quero saber sobre arroz integral");
  await waitChat(page, "O arroz integral é uma boa fonte");
  const state = await getState();
  equal(state.aiCalls, 1, "conversa livre deveria chamar a IA");
  const row = state.rows.find((item) => item.user_id === USER_A.id);
  equal(row.data.days[today()]?.meals?.length || 0, 0, "não deveria registrar refeição");
  assert(!(await chatText(page)).includes("Anotei"), "não deveria responder como registro");
  await send(page, "uma dúvida sobre arroz");
  const second = await waitFor(async () => {
    const current = await getState();
    return current.aiCalls === 2 ? current : null;
  });
  equal(second.aiCalls, 2, "dúvida com quantidade no início também vai para a IA");
  const again = second.rows.find((item) => item.user_id === USER_A.id);
  equal(again.data.days[today()]?.meals?.length || 0, 0, "dúvida não vira refeição");
  await page.close();
});

await check("8e. refeição composta usa a base local e quantidades por unidade", async () => {
  await resetAll();
  await seed(demoState({ days: {} }));
  const page = await newPage();
  await login(page, "A");
  await waitMain(page);
  await send(page, "Hoje comi 2 iogurtes grego 90 g cada, 100g contra file com gordura, 6 camaroes empanados com catupiry, 300g de risoto de arroz com camaroes pequenos, 2 copos de agua de coco.");
  const meal = await waitFor(async () => {
    const row = await rowFor(USER_A.id);
    const meals = row?.data.days[today()]?.meals || [];
    return meals.length ? meals[0] : null;
  });
  equal(meal.items.length, 5, "deveria anotar os cinco itens");
  const byName = Object.fromEntries(meal.items.map((item) => [item.name, item]));
  assert(byName["Iogurte grego zero"], "iogurte grego");
  assert(byName["Contra filé grelhado"], "contra filé");
  assert(byName["Camarão empanado com catupiry"], "camarão empanado");
  assert(byName["Risoto de arroz com camarão"], "risoto");
  assert(byName["Água de coco"], "água de coco");
  equal(byName["Iogurte grego zero"].grams, 180, "2 potes de 90 g");
  equal(byName["Contra filé grelhado"].grams, 100, "100 g de contra filé");
  equal(byName["Camarão empanado com catupiry"].grams, 90, "6 unidades de 15 g");
  equal(byName["Risoto de arroz com camarão"].grams, 300, "300 g de risoto");
  equal(byName["Água de coco"].grams, 500, "2 copos de 250 ml");
  await page.close();
});

await check("8f. nome de alimento sozinho é anotado sem IA", async () => {
  await resetAll();
  await seed(demoState({ days: {} }));
  const page = await newPage();
  await login(page, "A");
  await waitMain(page);
  await send(page, "sardinha");
  await waitChat(page, "Anotei no");
  const meal = await waitFor(async () => {
    const row = await rowFor(USER_A.id);
    const meals = row?.data.days[today()]?.meals || [];
    return meals.length ? meals[0] : null;
  });
  equal(meal.items.length, 1, "um item");
  equal(meal.items[0].name, "Sardinha em óleo", "sardinha da base local");
  equal(meal.items[0].grams, 100, "porção padrão");
  equal((await getState()).aiCalls, 0, "não deveria chamar a IA");
  await page.close();
});

for (const testCase of mealCases) {
  await check(`8g. ${testCase.name}`, async () => {
    await resetAll();
    await seed(demoState({ days: {} }));
    const page = await newPage();
    await login(page, "A");
    await waitMain(page);
    await send(page, testCase.message);
    await waitChat(page, "Anotei no");
    const meal = await waitFor(async () => {
      const row = await rowFor(USER_A.id);
      const meals = row?.data.days[today()]?.meals || [];
      return meals.length ? meals[0] : null;
    });
    equal(meal.items.length, testCase.expected.length, "quantidade de itens");
    for (const expected of testCase.expected) {
      const item = meal.items.find((entry) => entry.name === expected.name);
      assert(item, `item ausente: ${expected.name}`);
      equal(item.grams, expected.grams, `gramas de ${expected.name}`);
    }
    assert(Math.abs(meal.kcal - testCase.kcal) <= 2, `kcal ${meal.kcal} vs ${testCase.kcal}`);
    await page.close();
  });
}

await check("8h. preparação não vira alimento simples", async () => {
  await resetAll();
  await seed(demoState({ days: {} }));
  await setConfig({ foodMode: "notfound" });
  const page = await newPage();
  await login(page, "A");
  await waitMain(page);
  await send(page, "comi patê de sardinha");
  await waitChat(page, "Não encontrei");
  const row = await rowFor(USER_A.id);
  equal((row?.data.days[today()]?.meals || []).length, 0, "não deveria anotar patê como sardinha");
  await page.close();
});

await check("8i. pergunta sobre alimento não vira refeição", async () => {
  await resetAll();
  await seed(demoState({ days: {} }));
  const page = await newPage();
  await login(page, "A");
  await waitMain(page);
  await send(page, "sardinha é saudável?");
  await waitChat(page, "Uma dieta equilibrada");
  const state = await getState();
  equal(state.aiCalls, 1, "deveria chamar a IA");
  assert(state.aiQuestions.includes("sardinha é saudável?"), "pergunta deveria chegar à IA");
  const row = await rowFor(USER_A.id);
  equal((row?.data.days[today()]?.meals || []).length, 0, "pergunta não deveria virar refeição");
  await page.close();
});

await check("8j. botão Reportar envia mensagem e contexto", async () => {
  await resetAll();
  await seed(demoState({ days: {} }));
  const page = await newPage();
  await login(page, "A");
  await waitMain(page);
  await send(page, "sardinha");
  await waitChat(page, "Anotei no");
  await page.evaluate(() => {
    const buttons = [...document.querySelectorAll(".msg-report")];
    buttons[buttons.length - 1].click();
  });
  await page.waitForFunction(() => document.getElementById("report-dialog").open, { timeout: 5000 });
  const text = await page.$eval("#report-text", (element) => element.value);
  assert(text.includes('"question": "sardinha"'), "relatório sem a pergunta");
  assert(text.includes("Sardinha em óleo"), "relatório sem a resposta");
  assert(!text.includes('"name": "Ana"'), "relatório não deve expor o nome");
  await page.click("#report-send");
  const report = await waitFor(async () => {
    const current = await getState();
    return current.reports?.length ? current.reports[0] : null;
  });
  equal(report.question, "sardinha", "pergunta enviada");
  equal(report.version, "2.15.7", "versão enviada");
  equal(report.profile.name, undefined, "nome não deve ir no relatório");
  assert(report.today.meals.length === 1, "refeição deveria ir no contexto");
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
  await send(page, "quanto falta de proteína?");
  await waitChat(page, "Faltam 119 g de proteína");
  equal((await getState()).aiCalls, 0, "resposta local não deveria chamar a IA");
  await send(page, "o que posso jantar?");
  await waitChat(page, "Sugestão de jantar");
  equal((await getState()).aiCalls, 0, "sugestão local não deveria chamar a IA");
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

await check("14. links diretos das 6 abas abrem a tela certa", async () => {
  await resetAll();
  await seed(demoState());
  const page = await newPage();
  await login(page, "A");
  await waitMain(page);
  for (const view of ["diario", "viva", "alimentacao", "atividades"]) {
    await page.evaluate((hash) => { location.hash = `#${hash}`; }, view);
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitMain(page);
    await page.waitForFunction((name) => !document.getElementById(`view-${name}`).hidden, { timeout: 5000 }, view);
    equal(await page.$eval(`.tab[data-view="${view}"]`, (el) => el.getAttribute("aria-current")), "page", `aba ${view} ativa`);
  }
  await goView(page, "alimentacao");
  await page.click("#view-alimentacao [data-chat-prompt]");
  await page.waitForFunction(() => !document.getElementById("view-viva").hidden, { timeout: 5000 });
  equal(await page.$eval("#chat-input", (el) => el.value), "O que posso jantar?", "sugestão preenche o chat");
  await goView(page, "atividades");
  await page.click("#view-atividades [data-chat-prompt]");
  await page.waitForFunction(() => !document.getElementById("view-viva").hidden, { timeout: 5000 });
  equal(await page.$eval("#chat-input", (el) => el.value), "corri ", "registro preenche o chat");
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
  const tabs = await page.$$eval(".tab", (els) => els.map((el) => el.dataset.view));
  equal(tabs.length, 6, "6 abas no celular");
  equal(tabs.join(","), "hoje,viva,alimentacao,atividades,diario,perfil", "ordem das 6 abas");
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
  for (const view of ["hoje", "viva", "alimentacao", "atividades", "diario", "perfil"]) {
    await goView(page, view);
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    assert(width <= 390, `${view} vaza na horizontal: ${width}`);
  }
  await goView(page, "viva");
  await page.focus("#chat-input");
  await new Promise((resolve) => setTimeout(resolve, 120));
  const typing = await page.evaluate(() => {
    const view = document.getElementById("view-viva").getBoundingClientRect();
    const form = document.getElementById("chat-form").getBoundingClientRect();
    const log = document.getElementById("chat-log").getBoundingClientRect();
    return {
      classOn: document.body.classList.contains("chat-typing"),
      head: getComputedStyle(document.querySelector(".chat-head")).display,
      viewTop: view.top,
      viewHeight: view.height,
      formBottom: form.bottom,
      logHeight: log.height,
      innerHeight
    };
  });
  assert(typing.classOn, "foco no chat deveria ativar o modo de digitação");
  equal(typing.head, "none", "cabeçalho sai de cena para dar lugar à conversa");
  assert(typing.viewTop >= -1, "chat fica no topo visível");
  assert(typing.viewHeight >= 400, `chat precisa ocupar a tela: ${typing.viewHeight}`);
  assert(typing.logHeight >= 200, `histórico precisa aparecer: ${typing.logHeight}`);
  assert(typing.formBottom <= typing.innerHeight + 1, "campo precisa ficar acima do teclado");
  await page.evaluate(() => document.getElementById("chat-input").blur());
  await new Promise((resolve) => setTimeout(resolve, 300));
  const after = await page.evaluate(() => ({
    classOn: document.body.classList.contains("chat-typing"),
    head: getComputedStyle(document.querySelector(".chat-head")).display
  }));
  assert(!after.classOn, "sair do campo deveria fechar o modo de digitação");
  assert(after.head !== "none", "cabeçalho volta ao sair do campo");
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

await check("20. Perfil aceita chave própria opcional e o assistente local responde sem chave", async () => {
  await resetAll();
  const base = demoState();
  await seed(demoState({ profile: { ...base.profile, aiEnabled: false } }));
  await setConfig({ aiEndpoint: "/api/ai" });
  const page = await newPage();
  await login(page, "A");
  await waitMain(page);
  await goView(page, "perfil");
  await page.waitForFunction(() => !document.getElementById("ai-card").hidden, { timeout: 5000 });
  assert((await textOf(page, "#ai-server-status")).includes("não está configurada"), "status sem IA do app");
  equal(await page.$eval("#ai-provider", (element) => element.value), "openrouter", "OpenRouter gratuito como padrão");
  assert(await page.$eval("#pf-ai", (element) => element.disabled), "switch deve ficar desligado sem chave");
  await send(page, "quanto falta de proteína?");
  await waitChat(page, "Faltam 119 g de proteína");
  equal((await getState()).aiCalls, 0, "não deveria chamar IA");
  await goView(page, "perfil");
  await page.select("#ai-provider", "openai");
  await page.type("#ai-key", "sk-test-own");
  await page.click("#btn-ai-save");
  await page.waitForFunction(() => !document.getElementById("pf-ai").disabled, { timeout: 5000 });
  assert((await textOf(page, "#ai-key-status")).includes("Chave salva"), "status da chave própria");
  assert(await page.$eval("#pf-ai", (element) => element.checked), "salvar a chave deve ligar a IA");
  await send(page, "qual a melhor fruta?");
  await waitChat(page, "Resposta BYOK de teste.");
  const byok = await getState();
  equal(byok.lastAI.provider, "openai", "provedor da chave própria");
  equal(byok.lastAI.apiKey, "sk-test-own", "chave própria enviada ao proxy");
  await goView(page, "perfil");
  await page.click("#btn-ai-clear");
  await page.waitForFunction(() => document.getElementById("pf-ai").disabled, { timeout: 5000 });
  await page.close();
  await setConfig({ aiEndpoint: "" });
});

await check("21. IA do servidor e foto do prato usam a chave do servidor", async () => {
  await resetAll();
  const base = demoState();
  await seed(demoState({ profile: { ...base.profile, aiEnabled: true } }));
  await setConfig({
    aiEndpoint: "/api/ai",
    aiServer: { configured: true, provider: "openai", model: "gpt-4o-mini", vision: true }
  });
  const page = await newPage();
  await login(page, "A");
  await waitMain(page);
  await goView(page, "perfil");
  await page.waitForFunction(() => document.getElementById("ai-server-status").textContent.includes("IA incluída"), { timeout: 5000 });
  assert((await textOf(page, "#ai-server-status")).includes("IA incluída"), "status da IA do app");
  assert(!(await page.$eval("#ai-settings", (element) => element.hidden)), "campo opcional de chave deve ficar visível");
  assert(await page.$eval("#pf-ai", (element) => element.checked), "preferência de IA deve sobreviver ao carregamento da configuração");
  await send(page, "qual a melhor fruta?");
  await waitChat(page, "Resposta do servidor de teste.");
  const state = await getState();
  equal(state.lastAI.provider, "openai", "provedor do servidor");
  equal(state.lastAI.model, "gpt-4o-mini", "modelo do servidor");
  equal(state.lastAI.apiKey, undefined, "não deve pedir chave ao usuário");

  await goView(page, "alimentacao");
  await page.waitForFunction(() => document.getElementById("photo-status").textContent.includes("Aguardando"), { timeout: 5000 });
  const input = await page.$("#photo-input");
  await input.uploadFile(dishPng);
  await page.waitForFunction(() => !document.getElementById("photo-preview-wrap").hidden, { timeout: 5000 });
  await page.waitForFunction(() => !document.getElementById("photo-analyze").disabled, { timeout: 5000 });
  await page.click("#photo-analyze");
  await page.waitForFunction(() => document.getElementById("photo-result").innerText.includes("Arroz branco"), { timeout: 5000 });
  assert((await textOf(page, "#photo-result")).includes("230 kcal"), "total estimado pela foto");
  assert(!(await page.$eval("#photo-add", (element) => element.hidden)), "botão de adicionar deve aparecer");
  const photoCall = await getState();
  assert(photoCall.lastAI.hasImage, "a foto deveria chegar ao proxy");
  assert(photoCall.lastAI.imagePrefix.startsWith("data:image/jpeg;base64,"), "foto comprimida em JPEG");
  await page.$eval("#photo-add", (element) => element.click());
  const withPhotoMeal = await waitFor(async () => {
    const current = await rowFor(USER_A.id);
    const meals = current?.data.days[today()]?.meals || [];
    return meals.length === 1 ? current : null;
  });
  equal(withPhotoMeal.data.days[today()].meals[0].kcal, 230, "kcal da refeição por foto");
  equal(withPhotoMeal.data.days[today()].meals[0].items.length, 2, "itens da refeição por foto");
  await page.close();
  await setConfig({ aiEndpoint: "", aiServer: null });
});

await check("22. dashboard reúne perfil, metas, hoje, histórico e impressão", async () => {
  await resetAll();
  const base = demoState();
  const key = today();
  const day = {
    meals: [{
      id: "meal-dash",
      at: new Date().toISOString(),
      label: "Almoço",
      items: [{ name: "Arroz", grams: 100, kcal: 130, p: 2, c: 28, f: 0 }],
      kcal: 130,
      p: 2,
      c: 28,
      f: 0
    }],
    waterMl: 500,
    activities: [{ id: "act-dash", at: new Date().toISOString(), name: "Caminhada", minutes: 30, kcal: 100, intensity: "Leve" }]
  };
  await seed(demoState({ days: { [key]: day } }));
  const page = await newPage();
  await login(page, "A");
  await waitMain(page);
  await goView(page, "diario");
  await page.waitForFunction(() => document.getElementById("dashboard-body").innerText.toLowerCase().includes("histórico recente"), { timeout: 5000 });
  const body = await textOf(page, "#dashboard-body");
  assert(body.includes("Ana"), "perfil no dashboard");
  assert(body.includes("1.970 kcal"), "metas no dashboard");
  assert(body.includes("500 ml"), "água de hoje no dashboard");
  assert(body.includes("Caminhada") || body.includes("30 min"), "atividade no dashboard");
  assert(body.includes("Arroz"), "alimentos no dashboard");
  assert(body.toLowerCase().includes("histórico recente"), "histórico no dashboard");
  await page.evaluate(() => { window.__printed = false; window.print = () => { window.__printed = true; }; });
  await page.click("#btn-dashboard-print");
  assert(await page.evaluate(() => window.__printed), "botão deveria chamar impressão");
  await page.close();
});

await check("23b. perfil antigo ganha a IA incluída automaticamente", async () => {
  await resetAll();
  const base = demoState();
  await seed(demoState({ profile: { ...base.profile, aiEnabled: false } }));
  await setConfig({
    aiEndpoint: "/api/ai",
    aiServer: { configured: true, provider: "openrouter", model: "free", vision: false }
  });
  const page = await newPage();
  await login(page, "A");
  await waitMain(page);
  await page.waitForFunction(() => document.getElementById("pf-ai").checked, { timeout: 5000 });
  const row = await waitFor(async () => {
    const current = await rowFor(USER_A.id);
    return current?.data.profile.aiEnabled ? current : null;
  });
  equal(row.data.profile.aiEnabled, true, "IA incluída deveria ser ligada para perfil antigo");
  equal(row.data.profile.aiChoice, "on", "escolha deveria ficar registrada");
  await send(page, "testando se você está ok");
  await waitChat(page, "Resposta do servidor de teste.");
  equal((await getState()).lastAI?.question, "testando se você está ok", "mensagem livre deveria usar a IA");
  await page.close();
  await setConfig({ aiEndpoint: "", aiServer: null });
});

await check("23. nenhuma exceção de página durante os testes", async () => {
  assert(pageErrors.length === 0, pageErrors.join(" | "));
});

await browser.close();
await new Promise((resolve) => server.close(resolve));
console.log(`\n${passed} verificações ok, ${failed} falha(s).\n`);
process.exit(failed ? 1 : 0);
