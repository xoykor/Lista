# Lista

Serviço de playlist auto-curante para o Blazzing.

O Blazzing deve consumir um único endereço permanente:

    https://<worker>/list.m3u8

O serviço agrega fontes públicas configuradas, providers dinâmicos, normaliza nomes, combina URLs do mesmo canal e aplica fallback por canal.

## Atualização a cada 3 horas

O catálogo global Live é reconstruído por um Cron Trigger:

    0 */3 * * *

Ou seja, uma varredura global a cada 3 horas.

O resultado fica persistido em um Durable Object próprio. A M3U não depende da memória temporária de uma instância do Worker.

Se um refresh falhar, o serviço não apaga a lista publicada: continua entregando a última versão boa e registra o erro em /status.json.

A checagem de 3 horas é para catálogo/origens. Ela não atrasa o failover de reprodução: quando alguém abre um canal, a fonte ativa é verificada naquele momento e as alternativas continuam sendo tentadas imediatamente quando necessário.

## Fontes dinâmicas

Nenhuma fonte GitHub é presa a commit. Cada origem usa repositório + branch + caminho, então uma atualização feita por Ramys ou Saimo entra no próximo rebuild do catálogo.

### Pluto TV Brasil

A Pluto não entra por uma M3U comunitária. O serviço possui provider próprio:

1. abre uma sessão web anônima no boot da Pluto;
2. busca o lineup Live atual;
3. guarda somente o channelId no catálogo;
4. quando o canal é reproduzido, gera um HLS autenticado atual;
5. renova automaticamente o JWT antes de expirar ou após erro de autenticação.

Assim, os tokens temporários da Pluto nunca ficam congelados dentro de /list.m3u8.

O provider é configurado como região BR e usa contexto pt-BR. O catálogo regional ainda depende da região entregue pela própria Pluto à sessão anônima; não há spoofing de IP nem bypass geográfico.

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

## Merge e fallback

Canais equivalentes são unidos por nome normalizado. Se Pluto, Saimo e Ramys entregarem o mesmo canal, as origens entram no mesmo item como alternativas.

A política atual segue o comportamento observado no Saimo:
- mantém a fonte ativa enquanto funciona;
- usa a última playlist HLS boa para esconder até duas falhas transitórias;
- troca de origem na terceira falha consecutiva;
- a última playlist boa vale por 20 segundos;
- se todas as fontes falharem, preserva a preferência anterior para a próxima tentativa.

O Worker só entra no caminho quando há várias fontes, cabeçalhos especiais ou provider dinâmico. Canais triviais com uma única URL continuam diretos para evitar retransmitir vídeo desnecessariamente.

## Endpoints

- GET /list.m3u8 — lista Live agregada persistente
- GET /live.m3u8 — alias
- GET /sources.json — fontes e providers configurados
- GET /status.json — último refresh, próximo refresh, upstreams e último erro
- GET /healthz — saúde
- GET /vod.m3u8 — reservado para o índice VOD deduplicado

## VOD

1.m3u + 3.m3u + Filmes-Series.m3u8 passam de 128 MB brutos. Por isso o serviço não concatena esses arquivos. A integração VOD usa o índice compacto/fatiado publicado pelo Saimo como caminho para evitar reprocessar todo o acervo em cada acesso.

## Desenvolvimento

    npm install
    npm test
    npm run check
    npm run dev

## Deploy

    npx wrangler login
    npm run deploy
