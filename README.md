# Lista

Serviço de playlist auto-curante para o Blazzing.

O Blazzing deve consumir um único endereço permanente:

    https://<worker>/list.m3u8

O serviço agrega fontes públicas configuradas, normaliza nomes, combina URLs equivalentes como fallback e mantém o catálogo persistido em Durable Object.

## Arquitetura

O processamento pesado não roda no Cloudflare Worker.

A cada 12 horas, o GitHub Actions:

1. baixa as fontes Live configuradas;
2. consulta o lineup atual da Pluto TV Brasil;
3. remove variantes protegidas por ClearKey/DRM;
4. normaliza e deduplica os canais;
5. gera URLs de resolver assinadas;
6. divide o catálogo em blocos de até ~96 KiB;
7. envia uma nova geração para o Durable Object;
8. ativa a geração somente depois que todos os blocos foram recebidos.

Se o job falhar no meio, a geração anterior continua ativa.

Agendamento:

    17 */12 * * *

São duas execuções por dia. O minuto 17 evita concentrar o job exatamente na virada da hora.

## Worker

O Worker fica responsável apenas por:

- servir /list.m3u8 e /live.m3u8;
- armazenar o último catálogo válido;
- resolver canais com múltiplas fontes;
- renovar sessão/JWT da Pluto sob demanda;
- aplicar failover no momento da reprodução.

Não existe mais Cron Trigger pesado no Worker.

## Segurança

URLs /channel/... usam HMAC-SHA256. Um cliente não consegue fabricar um token válido para transformar o Worker em proxy de uma URL arbitrária.

O upload do catálogo também exige Bearer token.

Fontes Saimo marcadas com chave: são descartadas. O serviço não armazena nem utiliza ClearKey/DRM.

## Fontes

### Pluto TV Brasil

O provider usa o lineup atual para obter channelId. O catálogo guarda o channelId, não um JWT temporário.

Quando o canal é reproduzido, o Worker abre/renova uma sessão anônima e gera o HLS atual.

### SaimoPlayer

Live:
- catalogo.txt
- canais.txt

VOD registrado:
- 1.m3u
- 3.m3u

### Ramys / IPTV-Brasil-2026

Live:
- CanaisBR01.m3u8
- CanaisBR02.m3u8
- CanaisBR03.m3u8
- CanaisBR04.m3u8

VOD registrado:
- Filmes-Series.m3u8

## Failover

A política Live:

- mantém a fonte ativa enquanto funciona;
- usa a última playlist HLS boa para esconder até duas falhas transitórias;
- troca de origem na terceira falha consecutiva;
- a última playlist boa vale por 20 segundos;
- se todas as fontes falharem, preserva a preferência anterior para a próxima tentativa.

A atualização de 12 horas não atrasa esse comportamento: disponibilidade é verificada quando o canal é aberto.

## Endpoints

- GET /list.m3u8 — catálogo Live persistido
- GET /live.m3u8 — alias
- GET /sources.json — fontes configuradas
- GET /status.json — geração, último refresh e próximo refresh esperado
- GET /healthz — saúde
- GET /vod.m3u8 — VOD ainda em implementação

As rotas /_catalog/upload/* são usadas apenas pelo GitHub Actions e exigem autenticação.

## Desenvolvimento

    npm install
    npm test
    npm run check

## Deploy inicial

O deploy de produção é feito pelo workflow Deploy Worker. Ele usa a ação oficial cloudflare/wrangler-action e publica automaticamente a cada push na main, além de aceitar execução manual.

No repositório GitHub, configure estes secrets:

- CLOUDFLARE_API_TOKEN — token com permissão para editar Workers
- CLOUDFLARE_ACCOUNT_ID — ID da conta Cloudflare
- TOKEN_SECRET — segredo usado para assinar os resolvers
- CATALOG_UPLOAD_SECRET — segredo usado para publicar novas gerações do catálogo

O workflow de deploy configura TOKEN_SECRET e CATALOG_UPLOAD_SECRET no Worker e salva automaticamente a URL pública retornada pela Cloudflare em config/worker-url.txt. O refresh de 12 horas usa esse arquivo, então WORKER_URL não precisa ser cadastrado manualmente.

Esses valores não ficam no código nem no histórico Git.

Ao fazer deploy pela primeira vez, o workflow Deploy Worker publica o Worker, salva sua URL e já gera/publica o primeiro catálogo. Depois disso, Refresh catalog roda automaticamente a cada 12 horas.

## VOD

1.m3u + 3.m3u + Filmes-Series.m3u8 passam de 128 MB brutos. Por isso o serviço não concatena os arquivos brutos. O VOD será servido por índice compacto/fatiado separado.
