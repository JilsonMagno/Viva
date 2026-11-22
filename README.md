# Viva: assistente pessoal de saúde (Fase 2)

Versão com login, dados privados por conta e assistente com ChatGPT.
Front-end estático (uma página, sem bundler; `build.cjs` injeta `app.js` no `index.template.html`) + Supabase (login Google, Postgres com RLS, Edge Function).


## O que já está pronto e testado

- Login com Google pelo Supabase (PKCE), com renovação automática da sessão.
- Primeiro acesso sem dados de exemplo: você informa idade, altura, peso e objetivo, e a Viva calcula as metas iniciais.
- Cada conta lê e grava só a própria linha no banco (RLS).
- Registros pelo assistente (refeições, água, atividade e peso) são salvos na conta.
- Perguntas vão ao ChatGPT somente se você ligar a opção em Perfil.
- Exportar os dados em JSON e apagar tudo, com confirmação em dois toques.
- Instalável no celular (tela inicial), com casca em cache.
- Base de 83 alimentos com valores por 100 g, fonte e referência por item (TACO 4ª ed. e USDA FoodData Central).

Testes:
- `node tests/rls.test.mjs`: 10 verificações da migração e das regras de acesso, em Postgres real (PGlite).
- `node tests/foods.test.mjs`: 7 verificações da base de alimentos (83 itens, fonte/referência, plausibilidade e consistência com a referência oficial).
- `node tests/e2e.test.mjs`: 19 cenários no Chromium, com o Supabase simulado. Cobrem login PKCE, refresh, onboarding, persistência, IA ligada/desligada, falha da IA, exportação, exclusão, logout, isolamento entre contas, links diretos, PWA, acessibilidade, falha de rede e layout em 390 px.
- `npm test`: roda as três suítes.

## O que depende da sua conta (não consigo criar por você)

Criar contas, aceitar cobranças e gerar chaves exige o seu login. Estes são os passos mínimos:

1. **Supabase**: crie um projeto (plano gratuito). Em *Project Settings > API*, copie a **URL** e a chave **publishable/anon**.
2. **Google**: no Google Cloud, crie um *OAuth client* do tipo *Web application*. Em *Authorized redirect URIs*, use `https://SEU-PROJETO.supabase.co/auth/v1/callback`. Depois, em Supabase *Authentication > Providers > Google*, cole o Client ID e o Client Secret.
3. **Supabase, URLs de retorno**: em *Authentication > URL Configuration*, adicione a URL onde o site vai ficar (por exemplo `https://seu-site.netlify.app/`) em *Redirect URLs*.
4. **OpenAI**: crie uma chave em platform.openai.com. A API é cobrada à parte da assinatura do ChatGPT. Escolha um modelo da lista atual em developers.openai.com/api/docs/models e use o ID exato dele.
5. **Backend**: instale a Supabase CLI e rode `scripts/deploy-backend.sh` com as variáveis indicadas no próprio script.
6. **Site**: preencha `config.js` com a URL e a chave do passo 1. Publique esta pasta em um hosting estático (Netlify Drop, Cloudflare Pages ou GitHub Pages). O site precisa estar em HTTPS.

Depois disso, abra o link no celular e toque em *Adicionar à tela inicial*.

## Decisões

- **Banco e login: Supabase.** Uma linha `jsonb` por conta. É simples e suficiente para duas pessoas. Separar em tabelas por tipo de registro fica para a Fase 3.
- **IA: OpenAI, chamada pela Edge Function.** A chave fica como segredo do servidor e nunca vai ao navegador. A opção vem desligada. Registros de refeição, água, atividade e peso não são enviados à OpenAI.
- **Dados de saúde (LGPD):** cada conta vê só os próprios dados. O app tem exportação e exclusão. O texto de consentimento deve passar por revisão jurídica antes de o app ser usado por mais pessoas.
- **Fora desta versão:** lembretes, compartilhamento entre contas e exclusão da conta de login (o app apaga os dados, mas o usuário de autenticação continua existindo no Supabase).

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
- A função de IA tem limite em memória de 20 requisições/min por usuário, mas não tem limite diário por conta. Defina um limite persistente antes de dar acesso a outras pessoas.

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
config.js                        URL e chave pública do Supabase (você preenche)
manifest.webmanifest             instalação no celular
icon.svg, icon-192.png, icon-512.png
sw.js                            cache da casca do app (nunca cacheia /sb/)
supabase/config.toml             verify_jwt da função assistente
supabase/migrations/             tabela viva_data com RLS
supabase/functions/assistente/   função que chama a OpenAI
scripts/deploy-backend.sh        publica migração, segredos e função
tests/rls.test.mjs               RLS em Postgres real (PGlite)
tests/foods.test.mjs             base de alimentos e fontes
tests/e2e.test.mjs               fluxos completos no Chromium
tests/fixtures/                  referência auditável dos alimentos
tests/support/server.cjs         Supabase simulado para os testes
```
