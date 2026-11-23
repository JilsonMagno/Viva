create table if not exists public.viva_reports (
  id bigint generated always as identity primary key,
  user_id uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  app_version text not null default '',
  kind text not null default 'chat',
  message text not null default '',
  context jsonb not null default '{}'::jsonb,
  status text not null default 'open',
  constraint viva_reports_version_size check (char_length(app_version) <= 40),
  constraint viva_reports_kind_size check (char_length(kind) between 1 and 40),
  constraint viva_reports_message_size check (char_length(message) <= 8000),
  constraint viva_reports_context_object check (jsonb_typeof(context) = 'object'),
  constraint viva_reports_status_size check (char_length(status) <= 40)
);

comment on table public.viva_reports is 'Relatórios de problemas enviados pelo botão Reportar. Leitura apenas por service role.';

alter table public.viva_reports enable row level security;
alter table public.viva_reports force row level security;

revoke all on table public.viva_reports from anon;
grant insert on table public.viva_reports to authenticated;

drop policy if exists viva_reports_insert_own on public.viva_reports;
create policy viva_reports_insert_own on public.viva_reports
  for insert to authenticated
  with check ((select auth.uid()) = user_id);
