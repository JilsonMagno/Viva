import fs from "node:fs";
import { fileURLToPath } from "node:url";

const html = fs.readFileSync(fileURLToPath(new URL("../index.html", import.meta.url)), "utf8");
const reference = JSON.parse(fs.readFileSync(fileURLToPath(new URL("./fixtures/foods-reference.json", import.meta.url)), "utf8"));

const match = html.match(/const FOODS = (\[[\s\S]*?\n  \]);/);
if (!match) {
  console.error("Não encontrei o array FOODS em index.html");
  process.exit(1);
}
const foods = Function(`"use strict"; return ${match[1]};`)();

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  FAIL ${name}`);
    console.error(`       ${error.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

console.log("\nBase de alimentos da Viva\n");

check("1. a base tem 83 alimentos, com ids e nomes únicos", () => {
  assert(foods.length === 83, `esperava 83 alimentos, encontrei ${foods.length}`);
  const ids = new Set(foods.map((food) => food.id));
  const names = new Set(foods.map((food) => food.name));
  assert(ids.size === foods.length, "há ids repetidos");
  assert(names.size === foods.length, "há nomes repetidos");
});

check("2. todo alimento declara fonte oficial e referência", () => {
  for (const food of foods) {
    assert(["TACO", "USDA"].includes(food.src), `${food.id}: fonte inválida (${food.src})`);
    assert(/^\d+$/.test(String(food.ref)), `${food.id}: referência inválida`);
    assert(food.name && food.name.trim(), `${food.id}: nome vazio`);
    assert(Array.isArray(food.aliases) && food.aliases.length > 0, `${food.id}: sem aliases`);
    assert(Number(food.portion) > 0, `${food.id}: porção inválida`);
    for (const alias of food.aliases) {
      assert(typeof alias === "string" && alias.trim() === alias && alias.length > 0, `${food.id}: alias inválido "${alias}"`);
    }
  }
});

check("3. os valores são plausíveis por 100 g", () => {
  for (const food of foods) {
    for (const key of ["kcal", "p", "c", "f"]) {
      assert(Number.isFinite(food[key]) && food[key] >= 0, `${food.id}: ${key} inválido`);
    }
    assert(food.kcal <= 950, `${food.id}: kcal acima do plausível`);
    for (const key of ["p", "c", "f"]) {
      assert(food[key] <= 100, `${food.id}: ${key} acima de 100 g/100 g`);
    }
  }
});

check("4. a energia é compatível com os macronutrientes (Atwater)", () => {
  for (const food of foods) {
    const atwater = 4 * food.p + 4 * food.c + 9 * food.f;
    const tolerance = Math.max(30, food.kcal * 0.35);
    assert(Math.abs(food.kcal - atwater) <= tolerance, `${food.id}: ${food.kcal} kcal vs ${atwater.toFixed(1)} kcal (Atwater)`);
  }
});

check("5. cada alimento bate com a referência oficial registrada", () => {
  assert(reference.length === foods.length, `referência tem ${reference.length} itens, app tem ${foods.length}`);
  const byId = new Map(foods.map((food) => [food.id, food]));
  for (const expected of reference) {
    const actual = byId.get(expected.id);
    assert(actual, `${expected.id}: ausente no app`);
    for (const key of ["name", "kcal", "p", "c", "f", "src", "ref"]) {
      assert(actual[key] === expected[key], `${expected.id}: ${key} difere (app ${actual[key]}, referência ${expected[key]})`);
    }
    assert(expected.sourceDesc && expected.sourceDesc.length > 0, `${expected.id}: sem descrição da fonte`);
  }
});

check("6. as referências TACO e USDA estão nas faixas esperadas", () => {
  const taco = foods.filter((food) => food.src === "TACO");
  const usda = foods.filter((food) => food.src === "USDA");
  assert(taco.length === 64, `esperava 64 itens TACO, encontrei ${taco.length}`);
  assert(usda.length === 19, `esperava 19 itens USDA, encontrei ${usda.length}`);
  for (const food of taco) {
    const number = Number(food.ref);
    assert(number >= 1 && number <= 623, `${food.id}: número TACO fora da faixa (${number})`);
  }
  for (const food of usda) {
    assert(Number(food.ref) >= 100000, `${food.id}: fdcId do USDA inválido (${food.ref})`);
  }
});

check("7. a base cobre os grupos principais", () => {
  const groups = {
    cereais: ["arroz-branco", "pao-frances", "aveia", "macarrao", "cuscuz"],
    proteinas: ["ovo-cozido", "frango-peito", "patinho", "tilapia", "atum"],
    frutas: ["banana", "maca", "laranja", "mamao", "abacate"],
    vegetais: ["tomate", "cenoura", "brocolis", "abobrinha", "salada"],
    laticinios: ["leite", "iogurte", "queijo-mucarela", "requeijao"],
    gorduras: ["azeite", "manteiga", "castanha-para", "amendoim"]
  };
  for (const [group, ids] of Object.entries(groups)) {
    for (const id of ids) assert(foods.some((food) => food.id === id), `${group}: falta ${id}`);
  }
});

check("8. aliases da base e das preparações não se repetem", () => {
  const dishesMatch = html.match(/const DISHES = (\[[\s\S]*?\n  \]);/);
  assert(dishesMatch, "não encontrei o array DISHES em index.html");
  const dishes = Function(`"use strict"; return ${dishesMatch[1]};`)();
  const normalize = (text) => String(text).toLowerCase().normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ").trim();
  const seen = new Map();
  for (const entry of [...foods, ...dishes]) {
    for (const alias of entry.aliases) {
      const key = normalize(alias);
      assert(key, `${entry.id}: alias vazio após normalização`);
      assert(!seen.has(key) || seen.get(key) === entry.id, `${entry.id}: alias "${alias}" também pertence a ${seen.get(key)}`);
      seen.set(key, entry.id);
    }
  }
});

console.log(`\n${passed} verificações ok, ${failed} falha(s).\n`);
process.exit(failed ? 1 : 0);
