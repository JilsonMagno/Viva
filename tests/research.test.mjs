import { cleanQuery, meaningfulTerms, titleScore } from "../api/research.mjs";

let pass = 0;
let fail = 0;
function equal(actual, expected, label) {
  if (actual === expected) {
    pass += 1;
    console.log(`  ok  ${label}`);
  } else {
    fail += 1;
    console.error(`  FAIL ${label}: esperado ${JSON.stringify(expected)}, recebido ${JSON.stringify(actual)}`);
  }
}

console.log("Pesquisa web");
equal(cleanQuery("quero saber sobre arroz integral"), "arroz integral", "remove pedido e preposição");
equal(cleanQuery("me fale sobre jejum intermitente"), "jejum intermitente", "remove 'me fale sobre'");
equal(cleanQuery("pesquise se whey faz mal"), "whey", "remove comando e julgamento");
equal(cleanQuery("o que é creatina"), "creatina", "remove pergunta");
equal(cleanQuery("benefícios do arroz integral"), "arroz integral", "remove pedido de benefícios");
equal(meaningfulTerms("arroz integral").join(" "), "arroz integral", "termos relevantes");
equal(titleScore({ title: "Arroz integral" }, ["arroz", "integral"]), 2, "título com dois termos");
equal(titleScore({ title: "Bap" }, ["arroz", "integral"]), 0, "título sem termos");
console.log(`${pass} verificações ok, ${fail} falha(s).`);
process.exit(fail ? 1 : 0);
