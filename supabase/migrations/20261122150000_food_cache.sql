-- Cache global de alimentos consultados fora da tabela local.
-- O conteúdo é público (nome, macros e fonte), sem dados de saúde ou de conta.

create table if not exists public.viva_foods (
  query text primary key,
  food jsonb,
  found boolean not null default false,
  source text not null default 'Open Food Facts',
  source_url text,
  hits integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_used_at timestamptz not null default now(),
  constraint viva_foods_query_size check (char_length(query) between 2 and 120),
  constraint viva_foods_query_chars check (query ~ '^[a-z0-9 ]+$'),
  constraint viva_foods_food_object check (food is null or jsonb_typeof(food) = 'object'),
  constraint viva_foods_found_food check ((found and food is not null) or (not found and food is null)),
  constraint viva_foods_hits_nonnegative check (hits >= 0),
  constraint viva_foods_source_size check (char_length(source) between 1 and 80),
  constraint viva_foods_url_size check (source_url is null or char_length(source_url) <= 500)
);

comment on table public.viva_foods is 'Cache global de alimentos buscados no Open Food Facts.';

create index if not exists viva_foods_last_used_idx on public.viva_foods (last_used_at desc);

alter table public.viva_foods enable row level security;
alter table public.viva_foods force row level security;

revoke all on table public.viva_foods from anon;
revoke all on table public.viva_foods from authenticated;
grant select on table public.viva_foods to authenticated;

drop policy if exists viva_foods_select on public.viva_foods;
create policy viva_foods_select on public.viva_foods
  for select to authenticated
  using (true);

create or replace function public.viva_save_food(
  p_query text,
  p_food jsonb,
  p_found boolean,
  p_source text default 'Open Food Facts',
  p_source_url text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  q text := lower(trim(coalesce(p_query, '')));
  food_name text;
  kcal numeric;
  protein numeric;
  carbs numeric;
  fat numeric;
  serving numeric;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;

  p_found := coalesce(p_found, false);

  if char_length(q) < 2 or char_length(q) > 120 or q !~ '^[a-z0-9 ]+$' then
    raise exception 'invalid_query' using errcode = '22023';
  end if;

  if nullif(trim(p_source_url), '') is not null and p_source_url !~ '^https?://' then
    raise exception 'invalid_source_url' using errcode = '22023';
  end if;

  if p_found then
    if p_food is null or jsonb_typeof(p_food) <> 'object' then
      raise exception 'invalid_food' using errcode = '22023';
    end if;

    if p_food ? 'url' and (p_food ->> 'url') !~ '^https?://' then
      raise exception 'invalid_food_url' using errcode = '22023';
    end if;

    food_name := trim(coalesce(p_food ->> 'name', ''));
    if food_name = '' or char_length(food_name) > 120 then
      raise exception 'invalid_food_name' using errcode = '22023';
    end if;

    kcal := (p_food ->> 'kcal')::numeric;
    protein := (p_food ->> 'protein')::numeric;
    carbs := (p_food ->> 'carbs')::numeric;
    fat := (p_food ->> 'fat')::numeric;
    serving := nullif(p_food ->> 'servingGrams', '')::numeric;

    if kcal is null or kcal < 0 or kcal > 1000
      or protein is null or protein < 0 or protein > 100
      or carbs is null or carbs < 0 or carbs > 100
      or fat is null or fat < 0 or fat > 100
      or (serving is not null and (serving <= 0 or serving > 5000)) then
      raise exception 'invalid_food_values' using errcode = '22023';
    end if;
  else
    p_food := null;
  end if;

  insert into public.viva_foods (query, food, found, source, source_url)
  values (q, p_food, p_found, coalesce(nullif(trim(p_source), ''), 'Open Food Facts'), nullif(trim(p_source_url), ''))
  on conflict (query) do update set
    food = excluded.food,
    found = excluded.found,
    source = excluded.source,
    source_url = excluded.source_url,
    updated_at = now(),
    last_used_at = now();
end;
$$;

create or replace function public.viva_touch_food(p_query text)
returns void
language sql
security definer
set search_path = public
as $$
  update public.viva_foods
  set hits = hits + 1, last_used_at = now()
  where query = lower(trim(coalesce(p_query, '')));
$$;

revoke all on function public.viva_save_food(text, jsonb, boolean, text, text) from public, anon;
grant execute on function public.viva_save_food(text, jsonb, boolean, text, text) to authenticated;

revoke all on function public.viva_touch_food(text) from public, anon;
grant execute on function public.viva_touch_food(text) to authenticated;
