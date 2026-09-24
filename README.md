# Lista

Pipeline estático para produzir uma **playlist M3U canônica e regenerável**, agregando fontes externas, normalizando metadados, removendo entradas inadequadas ao catálogo e publicando fallbacks consumíveis diretamente por clientes compatíveis.

Fontes atualmente integradas:

- `gabrielsaimo/SaimoPlayer`
- `Ramys/Iptv-Brasil-2026`

Playlist pública:

`https://raw.githubusercontent.com/xoykor/Lista/static-fallback/list.m3u8`

## Objetivos de projeto

- manter um único endpoint estável para o catálogo publicado;
- evitar proxy próprio para reprodução de mídia;
- recuperar entradas quando upstreams voltam a fornecer URLs válidas;
- deduplicar e normalizar conteúdo vindo de fontes com taxonomias diferentes;
- gerar artefatos estáticos que continuem distribuíveis pelo GitHub;
- tornar auditoria e regeneração reproduzíveis por GitHub Actions.

## Arquitetura

O projeto é 100% estático no GitHub. Não existe Worker, proxy de reprodução,
servidor próprio nem dependência de Cloudflare.

O GitHub Actions:

1. baixa somente os arquivos necessários dos upstreams;
2. importa TV, filmes e séries;
3. resolve os formatos compactos do Saimo;
4. remove conteúdo restrito e fontes DRM/ClearKey;
5. deduplica e normaliza o catálogo;
6. sanitiza pools e uma janela rotativa de URLs;
7. escolhe a melhor fonte disponível como URL primária;
8. publica a playlist canônica com a URL real da mídia;
9. enriquece filmes e séries sem capa com posters do TMDB, quando a credencial está configurada;
10. publica shards estáticos de fallback e cards no branch `static-fallback`.

Fluxo normal:

```text
player -> URL primária real -> servidor de mídia
```

Fluxo de fallback para clientes compatíveis:

```text
player
  -> x-lista-fallback=<id>
  -> GitHub static-fallback/fallback/<prefixo>.json
  -> próxima URL real
```

Nenhuma reprodução passa por intermediário deste projeto.

## Playlist canônica

A playlist pública sempre contém uma URL real como URL de reprodução. Quando
há mais de uma fonte compatível, o `#EXTINF` também recebe:

```text
x-lista-fallback="<id>"
```

O cabeçalho informa onde ficam os shards estáticos:

```text
#EXT-X-LISTA-FALLBACK:https://raw.githubusercontent.com/xoykor/Lista/static-fallback/fallback
#EXT-X-LISTA-FALLBACK-VERSION:<versão>
#EXT-X-LISTA-FALLBACK-SHARD-LEN:2
```

O ID usa os dois primeiros caracteres para localizar o shard. Exemplo:

```text
id = a12bc34de56f78901234
shard = fallback/a1.json
```

Cada variante de fallback preserva:

1. URL;
2. origem;
3. Referer;
4. User-Agent.

Assim clientes compatíveis podem fazer failover local sem depender de
redirecionamentos HTTP.

## Taxonomia

A playlist usa `group-title` canônico.

- `TV | Abertos`, `TV | Esportes`, `TV | Notícias`, etc.
- `Filmes | Ação`, `Filmes | Comédia`, `Filmes | Terror`, etc.
- `Séries | Netflix`, `Séries | Prime Video`, `Séries | Disney+`,
  `Séries | Max`, `Séries | Globoplay`, `Séries | Anime`, etc.

Quando nenhum upstream fornece metadado suficiente, o item vai para
`Outros`.

## Sanitização

A checagem é econômica:

- contas/pools IPTV são testados por amostragem;
- URLs individuais são verificadas em rotação;
- respostas vazias, HTML/JSON no lugar de mídia e VODs minúsculos podem ser
  removidos como falhas definitivas;
- falhas transitórias permanecem inconclusivas;
- a quarentena de URLs mortas fica em `health-cache.json`;
- se todas as variantes de uma mídia forem removidas, a mídia sai do catálogo.

## Arquivos publicados

O branch `static-fallback` contém:

```text
list.m3u8
status.json
health-cache.json
artwork-cache.json
fallback/
cards/
```

`list.m3u8` é o único arquivo obrigatório para players M3U comuns. Os
diretórios `fallback/` e `cards/` são metadados adicionais para clientes
compatíveis.

## Capas externas

Quando um filme ou série não traz uma imagem válida na fonte original, o
pipeline pode consultar o TMDB pelo título e ano. A imagem encontrada não é
baixada nem armazenada neste repositório: o índice de cards guarda apenas a URL
do CDN do TMDB.

A ordem de preferência é:

1. imagem já fornecida pelo upstream;
2. resultado TMDB aceito pelo comparador conservador de título/ano;
3. ausência de imagem, quando não existe correspondência confiável.

Episódios compartilham a busca da série para evitar uma consulta por episódio.
O arquivo `artwork-cache.json` persiste resultados positivos e negativos entre
execuções. Resultados negativos expiram; falhas de rede/API não são gravadas
como ausência definitiva.

Para ativar o enriquecimento no GitHub Actions, configure um dos secrets:

- `TMDB_API_TOKEN` — token Bearer de leitura da API;
- `TMDB_API_KEY` — chave v3, usada como alternativa.

Sem esses secrets, a geração continua normalmente e apenas ignora a etapa
externa de enriquecimento. O limite padrão é de 50.000 títulos novos por execução, suficiente para
preencher o catálogo atual em uma única regeneração. As consultas são
limitadas em frequência e o cache acumulativo evita repetir buscas futuras.

This product uses the TMDB API but is not endorsed or certified by TMDB.


## Regeneração e recuperação

A playlist publicada é um **artefato derivado**. Alterações manuais no arquivo final podem desaparecer na próxima regeneração; correções duráveis devem ser feitas nas regras do pipeline.

Uma entrada removida por indisponibilidade pode reaparecer em uma execução futura quando a fonte upstream voltar a oferecê-la e ela passar novamente pelos filtros e verificações.

## Responsabilidade das fontes

Este repositório não hospeda os arquivos de mídia apontados pelas playlists. Disponibilidade, metadados e imagens dependem dos upstreams e provedores referenciados. O pipeline pode normalizar, filtrar e escolher URLs, mas não consegue restaurar conteúdo que deixou de existir na origem.

Use apenas fontes e conteúdos para os quais você tenha autorização de acesso.

## Licença

GNU General Public License v3.0 para o código do pipeline. Dados, URLs, metadados e conteúdos provenientes de terceiros permanecem sujeitos aos seus respectivos direitos e termos. Consulte [LICENSE](LICENSE).
