-- Viva, Fase 2: uma linha jsonb por conta, protegida por RLS.
-- A chave pública do app não dá acesso a nada sem um JWT válido do Supabase.

create table if not exists public.viva_data (
  user_id uuid primary key references auth.users (id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint viva_data_is_object check (jsonb_typeof(data) = 'object'),
  constraint viva_data_max_size check (pg_column_size(data) < 1048576)
);

comment on table public.viva_data is 'Dados privados da Viva: uma linha jsonb por conta.';

alter table public.viva_data enable row level security;
alter table public.viva_data force row level security;

revoke all on table public.viva_data from anon;
grant select, insert, update, delete on table public.viva_data to authenticated;

drop policy if exists viva_select_own on public.viva_data;
create policy viva_select_own on public.viva_data
  for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists viva_insert_own on public.viva_data;
create policy viva_insert_own on public.viva_data
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists viva_update_own on public.viva_data;
create policy viva_update_own on public.viva_data
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists viva_delete_own on public.viva_data;
create policy viva_delete_own on public.viva_data
  for delete to authenticated
  using ((select auth.uid()) = user_id);

create or replace function public.viva_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists viva_data_touch_updated_at on public.viva_data;
create trigger viva_data_touch_updated_at
  before update on public.viva_data
  for each row execute function public.viva_touch_updated_at();
