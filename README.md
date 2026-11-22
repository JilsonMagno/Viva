# Viva: assistente pessoal de saúde (Fase 2)

Versão com login, dados privados por conta e IA com a chave de cada usuário.
Front-end estático (uma página, sem bundler; `build.cjs` injeta `app.js` no `index.template.html`) + Supabase (login visitante/Google opcional, Postgres com RLS) + Vercel (hosting e proxy `/api/ai`).


## O que já está pronto e testado

- Login com Google pelo Supabase (PKCE), opcional e desligado por padrão, com renovação automática da sessão.
- Login visitante (anônimo) para usar sem OAuth; os dados ficam vinculados ao navegador.
- Primeiro acesso sem dados de exemplo: você informa idade, altura, peso e objetivo, e a Viva calcula as metas iniciais.
- Cada conta lê e grava só a própria linha no banco (RLS).
- Registros pelo assistente (refeições, água, atividade e peso) são salvos na conta.
- Perguntas vão ao provedor de IA escolhido, com a chave do próprio usuário, somente se você ligar a opção em Perfil.
- Exportar os dados em JSON e apagar tudo, com confirmação em dois toques.
- Instalável no celular (tela inicial), com casca em cache.
- Base de 83 alimentos com valores por 100 g, fonte e referência por item (TACO 4ª ed. e USDA FoodData Central).

Testes:
- `node tests/rls.test.mjs`: 11 verificações da migração e das regras de acesso, em Postgres real (PGlite), incluindo um usuário anônimo.
- `node tests/foods.test.mjs`: 7 verificações da base de alimentos (83 itens, fonte/referência, plausibilidade e consistência com a referência oficial).
- `node tests/e2e.test.mjs`: 21 cenários no Chromium, com o Supabase simulado. Cobrem login PKCE, login visitante, refresh, onboarding, persistência, IA ligada/desligada, falha da IA, IA com chave do próprio usuário (BYOK), exportação, exclusão, logout, isolamento entre contas, links diretos, PWA, acessibilidade, falha de rede e layout em 390 px.
- `npm test`: roda as três suítes.

## O que depende da sua conta (não consigo criar por você)

Criar contas e aceitar cobranças exige o seu login. Estes são os passos mínimos:

1. **Supabase**: crie um projeto (plano gratuito). Em *Project Settings > API*, copie a **URL** e a chave **publishable/anon**.
2. **Supabase, login visitante**: em *Authentication > Providers*, ative **Anonymous sign-ins**. É o caminho sem OAuth e o de menor atrito para compartilhar o link.
3. **Google (opcional)**: no Google Cloud, crie um *OAuth client* do tipo *Web application*. Em *Authorized redirect URIs*, use `https://SEU-PROJETO.supabase.co/auth/v1/callback`. Depois, em Supabase *Authentication > Providers > Google*, cole o Client ID e o Client Secret.
4. **Supabase, URLs de retorno (só com Google)**: em *Authentication > URL Configuration*, adicione a URL do site em *Redirect URLs*.
5. **Backend**: aplique a migração de `supabase/migrations/` no SQL Editor ou pela Supabase CLI para criar `viva_data` com RLS. A Edge Function `assistente` é legada; a IA de produção usa `/api/ai` no Vercel.
6. **Site**: preencha `config.js` com a URL e a chave do passo 1. O projeto Vercel já está conectado ao repositório; `npx vercel --prod` publica a pasta `public`.
7. **IA (por usuário)**: cada pessoa cola a própria chave em *Perfil > Assistente com IA*. O dono do app não precisa de chave da OpenAI e não paga a IA.

Depois disso, abra o link no celular e toque em *Adicionar à tela inicial*.

## Decisões

- **Banco e login: Supabase.** Uma linha `jsonb` por conta. É simples e suficiente para duas pessoas. Separar em tabelas por tipo de registro fica para a Fase 3.
- **IA: BYOK (bring your own key).** Cada usuário cola a própria chave (OpenAI, Groq, Gemini ou OpenRouter) em *Perfil*. A chave fica no `localStorage` do navegador, separada por `user.id`, e não vai para o Supabase. O app chama `/api/ai` no Vercel, que valida o JWT do Supabase e repassa a chave ao provedor sem armazená-la. A opção vem desligada. Registros de refeição, água, atividade e peso não são enviados ao provedor.
- **Dados de saúde (LGPD):** cada conta vê só os próprios dados. O app tem exportação e exclusão. O texto de consentimento deve passar por revisão jurídica antes de o app ser usado por mais pessoas.
- **Fora desta versão:** lembretes, compartilhamento entre contas e exclusão da conta de login (o app apaga os dados, mas o usuário de autenticação continua existindo no Supabase).

## IA com a chave do usuário (BYOK)

1. Abra *Perfil > Assistente com IA*.
2. Escolha o provedor: OpenAI, Groq, Google Gemini ou OpenRouter.
3. Cole a sua chave e toque em *Salvar chave*.
4. Ligue *Permitir perguntas à IA*.

A chave fica no `localStorage` do navegador, separada pelo `user.id`. Ela não é gravada no Supabase, não entra na exportação JSON e não vai para o repositório. O app envia a chave apenas para `/api/ai`, que valida o JWT do Supabase e repassa a chamada ao provedor sem armazenar a chave.

Use uma chave com limite de gasto. Para revogar, apague a chave no painel do provedor e remova a chave em *Perfil*. Em um dispositivo compartilhado, remova a chave ao sair.

Provedores e modelos padrão:

- **OpenAI:** `gpt-4o-mini`
- **Groq:** `llama-3.3-70b-versatile`
- **Google Gemini:** `gemini-2.0-flash`
- **OpenRouter:** `meta-llama/llama-3.3-70b-instruct:free`

O campo *Modelo* é opcional; se ficar vazio, o proxy usa o padrão do provedor.

## Base de alimentos e fontes

Os 83 alimentos ficam em `FOODS` (`app.js`) com valores por 100 g. Cada item tem `src` e `ref`:

- **TACO** — *Tabela Brasileira de Composição de Alimentos*, 4ª edição (2011), NEPA/UNICAMP. 64 itens. `ref` é o número do alimento na tabela oficial. Fonte: <https://nepa.unicamp.br/tabela-taco/> (planilha oficial `Taco-4a-Edicao.xlsx`). Os 64 valores foram conferidos item a item contra essa planilha: 64/64 batem.
- **USDA** — *FoodData Central*, do Departamento de Agricultura dos Estados Unidos. 19 itens. `ref` é o `fdcId`. Foram usados o *SR Legacy* (2018-04) e o *FNDDS* (2024-10-31). Fonte: <https://fdc.nal.usda.gov/>. Os 19 valores também foram conferidos contra os CSVs oficiais: 19/19 batem.

O arquivo `tests/fixtures/foods-reference.json` guarda, para cada item, a descrição exata da fonte oficial (por exemplo, `Arroz, tipo 1, cozido` ou `Fish, tilapia, cooked, dry heat`), além dos valores usados. É a referência auditável da base.

Decisões da curadoria:

- A TACO não traz energia/macronutrientes para leite UHT integral e desnatado (campos marcados `*`); esses dois itens usam o USDA.
- Alimentos que não existem como item único na TACO (pizza, sanduíche, sopa, sushi, granola, pasta de amendoim, salgadinho, sorvete, purê, leite de aveia, whey, tilápia, pera, atum em água, iogurte grego) usam o USDA.
- Preparações compostas sem entrada oficial única foram removidas em vez de estimadas: vitamina de banana, café com leite e temaki. Brigadeiro foi substituído por doce de leite (TACO).
- Quando a TACO marca um macro como `NA` ou traço (por exemplo, gordura de batata cozida), o valor foi tratado como 0 g/100 g. O item e a referência continuam registrados no fixture.

Valores de rótulos de produtos industrializados podem variar. A base serve para estimativas e não substitui orientação de nutricionista ou médico.

## Limites conhecidos

- Se dois aparelhos salvarem ao mesmo tempo, vale o último envio.
- A base tem 83 alimentos, com valores por 100 g da TACO 4ª ed. (NEPA/UNICAMP) e do USDA FoodData Central. Rótulos de produtos industrializados podem variar. Confira a embalagem quando ela existir.
- As metas são estimativas padrão (Mifflin-St Jeor com fator de atividade 1,5). Não substituem orientação de nutricionista ou médico.
- A IA usa a cota do provedor do próprio usuário. A chave fica no navegador; use uma chave com limite de gasto e revogue se o dispositivo for compartilhado. O proxy `/api/ai` não tem cota global porque não usa chave do dono.
- A chave de IA fica no `localStorage`; como qualquer credencial no navegador, ela pode ser lida por XSS ou por quem tiver acesso ao dispositivo. Não use uma chave com gasto ilimitado.

## Rodar localmente

```bash
npm install
npm run build          # gera index.html a partir de index.template.html + app.js
npm run serve          # Supabase simulado em http://127.0.0.1:12000
```

O `npm run serve` usa o servidor de testes e serve o app com login simulado, sem precisar de chaves reais. Para usar o Supabase de verdade, preencha `config.js` e publique a pasta em um hosting estático com HTTPS.

Os testes e2e usam o Chromium em `/usr/bin/chromium` e o `puppeteer-core`.

## Estrutura

```
index.html                       app (HTML, CSS e JS em um arquivo)
app.js                           lógica do app (fonte)
index.template.html              markup e CSS (fonte)
build.cjs                        gera index.html a partir do template + app.js
config.js                        URL e chave pública do Supabase; endpoint /api/ai
api/ai.mjs                       proxy BYOK no Vercel; valida o JWT e repassa a chave do usuário
manifest.webmanifest             instalação no celular
icon.svg, icon-192.png, icon-512.png
sw.js                            cache da casca do app (nunca cacheia /sb/)
supabase/config.toml             verify_jwt da função assistente legada
supabase/migrations/             tabela viva_data com RLS
supabase/functions/assistente/   função legada de IA com chave do servidor
scripts/deploy-backend.sh        publica migração, segredos e função
tests/rls.test.mjs               RLS em Postgres real (PGlite)
tests/foods.test.mjs             base de alimentos e fontes
tests/e2e.test.mjs               fluxos completos no Chromium
tests/fixtures/                  referência auditável dos alimentos
tests/support/server.cjs         Supabase simulado para os testes
```
