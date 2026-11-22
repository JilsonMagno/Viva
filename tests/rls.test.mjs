import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";

const migrationPath = fileURLToPath(new URL("../supabase/migrations/20261122090000_init.sql", import.meta.url));
const migration = fs.readFileSync(migrationPath, "utf8");

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function equal(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message} (esperado ${expected}, recebido ${actual})`);
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

const db = new PGlite();

async function asPostgres() {
  await db.exec("reset role");
  await db.query("select set_config('request.jwt.claims', '', false)");
}

async function asUser(id) {
  await db.exec("reset role");
  await db.exec("set role authenticated");
  await db.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify({ sub: id })]);
}

async function asAnon() {
  await db.exec("reset role");
  await db.exec("set role anon");
  await db.query("select set_config('request.jwt.claims', '', false)");
}

async function asAnonymous(id) {
  await db.exec("reset role");
  await db.exec("set role authenticated");
  await db.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify({ sub: id, is_anonymous: true, role: "authenticated" })]);
}

async function countRows(where, params = []) {
  const result = await db.query(`select count(*)::int as n from public.viva_data ${where}`, params);
  return result.rows[0].n;
}

console.log("\nRLS da Viva (Postgres real via PGlite)\n");

await db.exec(`
  create role anon nologin;
  create role authenticated nologin;
  create schema auth;
  create table auth.users (id uuid primary key, email text);
  create function auth.uid() returns uuid language sql stable as $$
    select (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid
  $$;
  grant usage on schema public to anon, authenticated;
`);

try {
  await db.exec(migration);
} catch (error) {
  console.error("A migração não aplicou:", error.message);
  process.exit(1);
}

await db.exec(`
  insert into auth.users (id, email) values
    ('${A}', 'ana@example.com'),
    ('${B}', 'bruno@example.com');
  insert into public.viva_data (user_id, data) values
    ('${A}', '{"profile":{"name":"Ana"}}'::jsonb),
    ('${B}', '{"profile":{"name":"Bruno"}}'::jsonb);
`);

await check("1. migração cria public.viva_data com as colunas esperadas", async () => {
  const result = await db.query(`
    select column_name, data_type, is_nullable
    from information_schema.columns
    where table_schema = 'public' and table_name = 'viva_data'
    order by ordinal_position
  `);
  const names = result.rows.map((row) => row.column_name);
  for (const name of ["user_id", "data", "created_at", "updated_at"]) {
    assert(names.includes(name), `coluna ${name} ausente`);
  }
  const data = result.rows.find((row) => row.column_name === "data");
  equal(data.data_type, "jsonb", "data deve ser jsonb");
});

await check("2. RLS está habilitado e forçado na tabela", async () => {
  const result = await db.query(`
    select relrowsecurity, relforcerowsecurity
    from pg_class where oid = 'public.viva_data'::regclass
  `);
  equal(result.rows[0].relrowsecurity, true, "row level security deve estar ligado");
  equal(result.rows[0].relforcerowsecurity, true, "row level security deve ser forçado");
});

await check("3. existem quatro políticas para o papel authenticated", async () => {
  const result = await db.query(`
    select policyname, cmd, roles::text as roles
    from pg_policies
    where schemaname = 'public' and tablename = 'viva_data'
  `);
  equal(result.rows.length, 4, "devem existir 4 políticas");
  const commands = result.rows.map((row) => row.cmd).sort();
  equal(commands.join(","), "DELETE,INSERT,SELECT,UPDATE", "políticas de select, insert, update e delete");
  for (const row of result.rows) assert(row.roles.includes("authenticated"), `política ${row.policyname} deve valer para authenticated`);
});

await check("4. anon não tem acesso à tabela", async () => {
  await asAnon();
  let denied = false;
  try {
    await db.query("select * from public.viva_data");
  } catch (error) {
    denied = error.code === "42501";
  }
  assert(denied, "consulta como anon deveria ser negada com 42501");
});

await check("5. usuário A lê apenas a própria linha", async () => {
  await asUser(A);
  const result = await db.query("select user_id, data from public.viva_data");
  equal(result.rows.length, 1, "A deve ver 1 linha");
  equal(result.rows[0].user_id, A, "a linha deve ser de A");
  equal(result.rows[0].data.profile.name, "Ana", "conteúdo deve ser o de A");
});

await check("6. usuário A não insere uma linha para B", async () => {
  await asUser(A);
  let denied = false;
  try {
    await db.query(`insert into public.viva_data (user_id, data) values ($1, '{"profile":{}}'::jsonb)`, [B]);
  } catch (error) {
    denied = error.code === "42501";
  }
  assert(denied, "insert com user_id de B deveria violar a política");
});

await check("7. usuário A não atualiza a linha de B", async () => {
  await asUser(A);
  const result = await db.query(`update public.viva_data set data = '{"profile":{"name":"invadido"}}'::jsonb where user_id = $1`, [B]);
  equal(result.affectedRows, 0, "nenhuma linha de B deve ser atualizada");
  await asPostgres();
  const checkB = await db.query("select data from public.viva_data where user_id = $1", [B]);
  equal(checkB.rows[0].data.profile.name, "Bruno", "dados de B devem permanecer intactos");
});

await check("8. usuário A não apaga a linha de B", async () => {
  await asUser(A);
  const result = await db.query("delete from public.viva_data where user_id = $1", [B]);
  equal(result.affectedRows, 0, "nenhuma linha de B deve ser apagada");
  await asPostgres();
  equal(await countRows("where user_id = $1", [B]), 1, "linha de B deve continuar existindo");
});

await check("9. usuário A insere e atualiza a própria linha, e updated_at muda", async () => {
  const C = "33333333-3333-4333-8333-333333333333";
  await asPostgres();
  await db.query("insert into auth.users (id, email) values ($1, 'carla@example.com') on conflict do nothing", [C]);
  await asUser(C);
  const inserted = await db.query(`insert into public.viva_data (user_id, data) values ($1, '{"profile":{"name":"Carla"}}'::jsonb)`, [C]);
  equal(inserted.affectedRows, 1, "insert da própria linha deve funcionar");
  const first = await db.query("select updated_at from public.viva_data where user_id = $1", [C]);
  await db.query("select pg_sleep(0.03)");
  const updated = await db.query(`update public.viva_data set data = '{"profile":{"name":"Carla 2"}}'::jsonb where user_id = $1`, [C]);
  equal(updated.affectedRows, 1, "update da própria linha deve funcionar");
  const second = await db.query("select updated_at, data from public.viva_data where user_id = $1", [C]);
  assert(new Date(second.rows[0].updated_at) > new Date(first.rows[0].updated_at), "updated_at deve avançar no update");
  equal(second.rows[0].data.profile.name, "Carla 2", "dados devem ser atualizados");
});

await check("10. dados inválidos são rejeitados e apagar a conta remove a linha", async () => {
  await asPostgres();
  let rejected = false;
  try {
    await db.query(`insert into public.viva_data (user_id, data) values ($1, '[1,2,3]'::jsonb)`, [A]);
  } catch (error) {
    rejected = error.code === "23514";
  }
  assert(rejected, "jsonb que não é objeto deveria violar a constraint");
  await db.query("delete from auth.users where id = $1", [B]);
  equal(await countRows("where user_id = $1", [B]), 0, "a linha de B deve sumir em cascata");
  equal(await countRows("where user_id = $1", [A]), 1, "a linha de A deve continuar");
});

await check("11. usuário anônimo só acessa a própria linha", async () => {
  const D = "44444444-4444-4444-8444-444444444444";
  await asPostgres();
  await db.query("insert into auth.users (id, email) values ($1, null) on conflict do nothing", [D]);
  await asAnonymous(D);
  const inserted = await db.query(`insert into public.viva_data (user_id, data) values ($1, '{"profile":{"name":"Visitante"}}'::jsonb)`, [D]);
  equal(inserted.affectedRows, 1, "anônimo deve inserir a própria linha");
  const own = await db.query("select user_id from public.viva_data");
  equal(own.rows.length, 1, "anônimo deve ver só a própria linha");
  equal(own.rows[0].user_id, D, "a linha deve ser do anônimo");
  const other = await db.query("select count(*)::int as n from public.viva_data where user_id = $1", [A]);
  equal(other.rows[0].n, 0, "anônimo não deve ver a linha de A");
  let denied = false;
  try {
    await db.query(`insert into public.viva_data (user_id, data) values ($1, '{"profile":{}}'::jsonb)`, [A]);
  } catch (error) {
    denied = error.code === "42501";
  }
  assert(denied, "anônimo não deve inserir para A");
});

await asPostgres();
await db.close();

console.log(`\n${passed} verificações ok, ${failed} falha(s).\n`);
process.exit(failed ? 1 : 0);
