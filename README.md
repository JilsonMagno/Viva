# Viva: assistente pessoal de saúde (Fase 2)

Versão com login, dados privados por conta, IA incluída no app e opção de o usuário usar a própria chave.
Front-end estático (uma página, sem bundler; `build.cjs` injeta `app.js` no `index.template.html`) + Supabase (login visitante/Google opcional, Postgres com RLS) + Vercel (hosting e proxy `/api/ai`).

## O que já está pronto e testado

- Login com Google pelo Supabase (PKCE), opcional e desligado por padrão, com renovação automática da sessão.
- Login visitante (anônimo) para usar sem OAuth; os dados ficam vinculados ao navegador.
- Primeiro acesso sem dados de exemplo: você informa idade, altura, peso e objetivo, e a Viva calcula as metas iniciais.
- Cada conta lê e grava só a própria linha no banco (RLS).
- Registros pelo assistente (refeições, água, atividade e peso) são salvos na conta.
- Perguntas vão à IA incluída no app quando o dono configura a chave no servidor. O usuário pode, opcionalmente, salvar a própria chave (OpenAI, Gemini, Groq ou OpenRouter) em Perfil; ela fica só no navegador e tem prioridade. Sem nenhuma chave, o assistente local responde sobre proteína, calorias, água, resumo e sugestão de jantar.
- Foto do prato: a IA com visão estima alimentos, porções e kcal; o usuário confere e adiciona ao diário.
- Dashboard completo em Evolução: perfil, metas, hoje, médias de 7 e 14 dias, peso, alimentos mais registrados e histórico recente, com impressão/PDF.
- Exportar os dados em JSON e apagar tudo, com confirmação em dois toques.
- Instalável no celular (tela inicial), com casca em cache.
- Base de 83 alimentos com valores por 100 g, fonte e referência por item (TACO 4ª ed. e USDA FoodData Central).
- Quantidades por texto: colheres de sopa/chá, colheres comuns, copos, xícaras, fatias, gramas, ml, unidades e porções. `4 colheres de aveia` e `1 colher de aveia` geram porções e calorias diferentes.
- Nomes fora da tabela: o app consulta o Open Food Facts, usa os valores por 100 g e mostra a fonte. Se não houver dados completos, não anota e não inventa valores.

## Layout

Seis abas, iguais às do app original e do protótipo:

- **Início**: resumo de kcal e macros, atalhos, água, peso e hábitos da semana.
- **Assistente**: conversa e registro por texto.
- **Alimentação** (rótulo curto **Refeições** no celular): refeições agrupadas por café da manhã, almoço, lanche e jantar, com resumo do dia e sugestão.
- **Atividades**: minutos dos últimos 7 dias, atividades de hoje, simulador de gasto por tipo/intensidade/duração e registro pelo assistente.
- **Evolução**: dashboard completo, últimos 14 dias, médias e histórico de peso. O dashboard pode ser impresso ou salvo em PDF.
- **Perfil**: metas, IA incluída, campo opcional de chave própria, exportação e exclusão.

Os IDs internos antigos (`hoje`, `viva`, `diario`) foram mantidos para não quebrar links diretos; os rótulos visíveis são os seis acima.

Testes:
- `node tests/rls.test.mjs`: 11 verificações da migração e das regras de acesso, em Postgres real (PGlite), incluindo um usuário anônimo.
- `node tests/foods.test.mjs`: 7 verificações da base de alimentos (83 itens, fonte/referência, plausibilidade e consistência com a referência oficial).
- `node tests/ai-proxy.test.mjs`: 9 verificações do proxy `/api/ai`, incluindo chave do servidor, chave do usuário, visão OpenAI, Gemini nativo, modelos gratuitos de Groq/OpenRouter e recusa de foto no Groq.
- `node tests/food-api.test.mjs`: 7 verificações da busca de alimentos fora da tabela no Open Food Facts, incluindo JWT, plural, valores por 100 g e ausência de dados.
- `node tests/e2e.test.mjs`: 27 cenários no Chromium, com o Supabase simulado. Cobrem login PKCE, login visitante, refresh, onboarding, persistência, IA ligada/desligada, falha da IA, IA do servidor sem chave do usuário, chave própria (BYOK), foto do prato, quantidades, nomes fora da tabela, dashboard/impressão, respostas locais, exportação, exclusão, logout, isolamento entre contas, links diretos, as 6 abas, PWA, acessibilidade, falha de rede e layout em 390 px em todas as abas.
- `npm test`: roda as cinco suítes.

## Desempenho medido (produção, 2026-11-22)

- `index.html`: 176.012 bytes crus, 45.740 bytes em gzip e 47.844 bytes em Brotli. É uma única requisição de HTML; não há CSS ou JavaScript externo, imagens de layout ou fontes web.
- O app carrega a configuração pública, a sessão do Supabase e, se houver, a configuração da IA. O dashboard renderiza no máximo 30 dias por vez.
- A foto do prato é reduzida no navegador para no máximo 1280 px e JPEG com qualidade ~0,82 antes de sair do dispositivo.
- O service worker guarda a casca do app; a versão atual é `viva-v2.8.0`.

## O que depende da sua conta (não consigo criar por você)

Criar contas e aceitar cobranças exige o seu login. Estes são os passos mínimos:

1. **Supabase**: crie um projeto (plano gratuito). Em *Project Settings > API*, copie a **URL** e a chave **publishable/anon**.
2. **Supabase, login visitante**: em *Authentication > Providers*, ative **Anonymous sign-ins**. É o caminho sem OAuth e o de menor atrito para compartilhar o link.
3. **Google (opcional)**: no Google Cloud, crie um *OAuth client* do tipo *Web application*. Em *Authorized redirect URIs*, use `https://SEU-PROJETO.supabase.co/auth/v1/callback`. Depois, em Supabase *Authentication > Providers > Google*, cole o Client ID e o Client Secret.
4. **Supabase, URLs de retorno (só com Google)**: em *Authentication > URL Configuration*, adicione a URL do site em *Redirect URLs*.
5. **Backend**: aplique a migração de `supabase/migrations/` no SQL Editor ou pela Supabase CLI para criar `viva_data` com RLS. A Edge Function `assistente` é legada; a IA de produção usa `/api/ai` no Vercel.
6. **Site**: preencha `config.js` com a URL e a chave do passo 1. O projeto Vercel já está conectado ao repositório; `npx vercel --prod` publica a pasta `public`. Se trocar de projeto Supabase, defina também `SUPABASE_URL` e `SUPABASE_ANON_KEY` nas variáveis do Vercel; `api/ai.mjs` valida o JWT com elas.
7. **IA (opcional, uma vez, pelo dono)**: em *Vercel > Project > Settings > Environment Variables*, crie `AI_API_KEY` com uma chave de OpenAI, Groq, Gemini ou OpenRouter. Para começar sem custo, use uma chave gratuita de OpenRouter, Gemini ou Groq (veja a seção **IA gratuita**). Opcionalmente defina `AI_PROVIDER`, `AI_MODEL` e `AI_VISION_MODEL`. Depois faça um novo deploy. O usuário pode usar essa IA só com login ou salvar a própria chave em Perfil. Sem `AI_API_KEY`, o cartão continua disponível para quem quiser usar a própria chave; sem nenhuma chave, o assistente local responde.

Depois disso, abra o link no celular e toque em *Adicionar à tela inicial*.

## Quantidades e nomes fora da tabela

O assistente entende a quantidade antes do alimento: `4 colheres de aveia` usa 60 g (4 × 15 g), enquanto `1 colher de aveia` usa 15 g. Também aceita colher de sopa (15 g), colher de chá (5 g), copo (250 g), xícara (200 g), fatia (30 g), gramas, ml, litros, unidades, porções, prato, concha, scoop, barra, lata, pacote e pote.

Quando o nome não está nos 83 alimentos da tabela, o app consulta o **Open Food Facts** pelo endpoint `/api/food`, valida o JWT do Supabase e usa os valores por 100 g do produto encontrado. A resposta mostra `Fonte: Open Food Facts`. Se a base não tiver kcal, proteína, carboidratos e gordura completos, o app **não anota e não inventa**: pede a porção e as kcal ou o uso de um alimento da tabela. A IA não é usada para estimar valores nutricionais de nomes desconhecidos.

O Google não oferece uma API pública gratuita de nutrição estruturada; por isso a busca externa usa o Open Food Facts. Se você tiver uma API de busca própria, ela pode ser adicionada em `api/food.mjs`.

## Decisões

- **Banco e login: Supabase.** Uma linha `jsonb` por conta. É simples e suficiente para duas pessoas. Separar em tabelas por tipo de registro fica para a Fase 3.
- **IA: chave do dono no servidor por padrão; chave própria opcional.** O Vercel guarda `AI_API_KEY`; o navegador nunca recebe essa chave. O app chama `/api/ai`, que valida o JWT do Supabase, aplica limite de 30 perguntas/min por usuário e repassa a pergunta ao provedor. Quem preferir pode salvar a própria chave em Perfil; ela fica no `localStorage` daquele navegador e tem prioridade sobre a chave do servidor. Registros de refeição, água, atividade e peso não são enviados ao provedor; só o texto da pergunta e, quando o usuário pede, a foto do prato. Nomes de alimentos fora da tabela são enviados ao Open Food Facts para consulta; os valores ficam no seu diário no Supabase.
- **Dados de saúde (LGPD):** cada conta vê só os próprios dados. O app tem exportação e exclusão. O texto de consentimento deve passar por revisão jurídica antes de o app ser usado por mais pessoas.
- **Fora desta versão:** lembretes, compartilhamento entre contas e exclusão da conta de login (o app apaga os dados, mas o usuário de autenticação continua existindo no Supabase).

## IA: chave do dono ou chave própria

O cartão *Assistente com IA* fica em Perfil. Se o dono configurou `AI_API_KEY`, o usuário só liga a permissão e usa a IA incluída. Se quiser, pode salvar a própria chave; ela fica só no navegador, é enviada ao proxy `/api/ai` em cada pergunta e tem prioridade sobre a chave do servidor. O proxy valida o JWT do Supabase e nunca devolve a chave do servidor ao navegador.

Configuração da IA do servidor, uma vez:

1. Crie uma chave em OpenAI, Groq, Google Gemini ou OpenRouter.
2. No Vercel, em *Settings > Environment Variables*, adicione `AI_API_KEY` em *Production*. Opcional: `AI_PROVIDER` (`openai`, `groq`, `gemini`, `openrouter`), `AI_MODEL` e `AI_VISION_MODEL`.
3. Faça um novo deploy (`npx vercel --prod`).
4. Abra Perfil: o cartão mostra “IA incluída no app”. Ligue a permissão uma vez.

Sem `AI_API_KEY`, o usuário ainda pode salvar a própria chave. Sem nenhuma chave, o assistente local responde:

- “quanto falta de proteína?”
- “quantas calorias faltam?”
- “quanta água falta?”
- “como estou hoje?”
- “o que posso jantar?”
- “estou com dor/cansaço” (orienta procurar um profissional)

Privacidade: só o texto da pergunta e, quando o usuário envia uma foto, a imagem do prato vão ao provedor; refeições, água, atividade e peso ficam no Supabase. Limite: 30 perguntas/min por usuário. O dono paga o uso da chave do servidor; quem usa a própria chave paga o próprio provedor. Acompanhe o gasto no provedor.

Provedores e modelos padrão:

- **Padrão do app:** OpenRouter `openrouter/free` (grátis; texto e foto)
- **OpenAI:** `gpt-4o-mini` (API paga; aceita fotos)
- **Groq:** `openai/gpt-oss-120b` (plano gratuito; só texto, não aceita fotos)
- **Google Gemini:** `gemini-3.5-flash-lite` (camada gratuita; aceita fotos)
- **OpenRouter:** `openrouter/free` (roteador gratuito; aceita fotos; alternativa fixa: `google/gemma-4-31b-it:free`)

O proxy aceita `apiKey` no corpo para a chave própria do usuário. A chave do servidor continua sendo o padrão quando o campo está vazio. O seletor de provedor já abre em **OpenRouter (grátis)**, usando `openrouter/free`; para usar um modelo pago, o usuário escolhe o provedor, cola a própria chave e informa o modelo. Ao remover a chave, o app volta ao padrão do servidor.

## IA gratuita (por enquanto)

Dá para usar um modelo gratuito sem mudar o código: o app já aceita os três caminhos abaixo e o seletor já vem em OpenRouter (grátis). O que não dá para fazer daqui é criar a conta/chave por você.

**Opção 1: OpenRouter (melhor para texto e foto)**

1. Crie uma conta em <https://openrouter.ai> e uma chave em <https://openrouter.ai/keys>.
2. No Vercel, adicione `AI_API_KEY` com a chave `sk-or-...`. O app detecta o provedor pelo prefixo.
3. Opcional: `AI_MODEL=openrouter/free` e `AI_VISION_MODEL=openrouter/free`. Esse roteador escolhe automaticamente um modelo gratuito disponível com suporte a imagem. Se quiser um modelo fixo, use `google/gemma-4-31b-it:free`.
4. Faça o deploy. Modelos `:free` têm limite diário/minuto e podem ficar indisponíveis em horário de pico.

**Opção 2: Google Gemini (foto e texto, camada gratuita)**

1. Crie uma chave em <https://aistudio.google.com/app/apikey>.
2. No Vercel, adicione `AI_API_KEY` com a chave `AIza...`.
3. Opcional: `AI_MODEL=gemini-3.5-flash-lite` e `AI_VISION_MODEL=gemini-3.5-flash-lite`.
4. A camada gratuita tem limites e, segundo o Google, usa o conteúdo para melhorar os produtos. Não envie dados sensíveis.

**Opção 3: Groq (só texto, plano gratuito)**

1. Crie uma chave em <https://console.groq.com/keys>.
2. No Vercel, adicione `AI_API_KEY` com a chave `gsk_...`.
3. Opcional: `AI_MODEL=openai/gpt-oss-120b`.
4. O Groq não analisa fotos; para foto use OpenRouter ou Gemini.

**Sem deploy:** o usuário pode colar a própria chave gratuita em *Perfil > Assistente com IA*. Ela fica só no navegador e já funciona no site publicado.

**Sem chave nenhuma:** o assistente local continua respondendo sobre metas, água, calorias e sugestões; não é um modelo generativo.

Os limites gratuitos mudam com frequência. Confira a página de preços/limites do provedor antes de compartilhar o app com muitas pessoas.

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
- A IA do servidor tem limite de 30 perguntas/min por usuário; a cota do provedor é do dono. A chave própria usa a cota do provedor do usuário.
- A chave própria fica no `localStorage`; como qualquer credencial no navegador, ela pode ser lida por XSS ou por quem tiver acesso ao dispositivo. Use uma chave com limite de gasto e revogue se o dispositivo for compartilhado. A chave é removida no logout e ao apagar os dados.
- A foto é comprimida no navegador antes do envio, mas ainda sai do dispositivo. Não envie fotos com pessoas identificáveis sem necessidade.

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
api/ai.mjs                       proxy da IA; valida o JWT, usa chave do servidor ou do usuário e aceita fotos (visão)
api/food.mjs                     busca nomes fora da tabela no Open Food Facts, com valores por 100 g
manifest.webmanifest             instalação no celular
icon.svg, icon-192.png, icon-512.png
sw.js                            cache da casca do app (nunca cacheia /sb/)
supabase/config.toml             verify_jwt da função assistente legada
supabase/migrations/             tabela viva_data com RLS
supabase/functions/assistente/   função legada de IA com chave do servidor
scripts/deploy-backend.sh        publica migração, segredos e função
tests/rls.test.mjs               RLS em Postgres real (PGlite)
tests/foods.test.mjs             base de alimentos e fontes
tests/ai-proxy.test.mjs          contrato do proxy de IA e visão
tests/food-api.test.mjs          contrato da busca de alimentos fora da tabela
tests/e2e.test.mjs               fluxos completos no Chromium
tests/fixtures/                  referência auditável dos alimentos
tests/support/server.cjs         Supabase simulado para os testes
```
