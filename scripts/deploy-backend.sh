#!/usr/bin/env bash
# Publica migração, segredos e a Edge Function no Supabase.
# Uso:
#   SUPABASE_PROJECT_REF=abcd1234 \
#   OPENAI_API_KEY=sk-... \
#   OPENAI_MODEL=gpt-4.1-mini \
#   ALLOWED_ORIGIN=https://seu-site.example \
#   ./scripts/deploy-backend.sh
#
# Requer a Supabase CLI instalada (https://supabase.com/docs/guides/cli).
# Na primeira vez, a CLI pede login e a senha do banco do projeto.

set -euo pipefail

cd "$(dirname "$0")/.."

: "${SUPABASE_PROJECT_REF:?Defina SUPABASE_PROJECT_REF (Project Settings > General > Reference ID)}"
: "${OPENAI_API_KEY:?Defina OPENAI_API_KEY}"
: "${OPENAI_MODEL:?Defina OPENAI_MODEL com o ID exato do modelo}"
ALLOWED_ORIGIN="${ALLOWED_ORIGIN:-*}"

if ! command -v supabase >/dev/null 2>&1; then
  echo "Supabase CLI não encontrada. Instale com: brew install supabase/tap/supabase" >&2
  exit 1
fi

echo "→ Vinculando ao projeto $SUPABASE_PROJECT_REF"
supabase link --project-ref "$SUPABASE_PROJECT_REF"

echo "→ Aplicando migrações"
supabase db push

echo "→ Gravando segredos da função"
supabase secrets set \
  --project-ref "$SUPABASE_PROJECT_REF" \
  OPENAI_API_KEY="$OPENAI_API_KEY" \
  OPENAI_MODEL="$OPENAI_MODEL" \
  ALLOWED_ORIGIN="$ALLOWED_ORIGIN"

echo "→ Publicando a função assistente"
supabase functions deploy assistente --project-ref "$SUPABASE_PROJECT_REF"

echo
echo "Pronto. Confira em Supabase > Edge Functions > assistente > Logs."
echo "Não esqueça de preencher config.js com a URL e a chave publishable do projeto."
