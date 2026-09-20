# Lista

Uma única playlist M3U regenerada automaticamente a partir de:

- `gabrielsaimo/SaimoPlayer`
- `Ramys/Iptv-Brasil-2026`

Playlist pública:

`https://raw.githubusercontent.com/xoykor/Lista/static-fallback/list.m3u8`

## Arquitetura

O catálogo é construído inteiramente no GitHub Actions. O Cloudflare Worker é
somente uma fachada de publicação: ele redireciona para a playlist do branch
`static-fallback`. A geração e a sanitização fazem **0 requisições ao Worker**,
e não há upload do catálogo pesado para a Cloudflare.

A cada execução o workflow:

1. baixa somente os arquivos necessários dos dois upstreams com clone raso e
   sparse checkout;
2. importa TV ao vivo, filmes e episódios de séries;
3. resolve o formato compacto do VOD do Saimo, inclusive os arquivos
   `vod/series-*.txt` e `vod/redeflix/links-*.txt`;
4. remove conteúdo restrito e fontes DRM/ClearKey;
5. deduplica itens entre as duas origens;
6. normaliza a taxonomia;
7. testa pools de streaming e uma janela rotativa de URLs individuais;
8. mantém uma quarentena de URLs definitivamente mortas entre execuções;
9. remove mídias que ficaram sem nenhuma fonte utilizável;
10. publica somente uma playlist de consumo: `list.m3u8`.

O workflow faz uma única checagem dos HEADs dos dois upstreams a cada 12 horas.
Se SaimoPlayer ou Iptv-Brasil-2026 mudou desde a checagem anterior, ele regenera
a lista. Mesmo sem mudança de upstream, a mesma execução de 12 horas refaz a
sanitização.

## Taxonomia

A playlist usa `group-title` canônico.

- `TV | Abertos`, `TV | Esportes`, `TV | Notícias`, etc.
- `Filmes | Ação`, `Filmes | Comédia`, `Filmes | Terror`, etc.
- `Séries | Netflix`, `Séries | Prime Video`, `Séries | Disney+`,
  `Séries | Max`, `Séries | Globoplay`, `Séries | Anime`, etc.

Quando nenhum dos dois upstreams fornece metadado suficiente, o item vai para
`Outros` em vez de receber uma categoria inventada.

## Sanitização

A checagem é deliberadamente econômica:

- contas/pools IPTV são testados por amostragem; se o pool inteiro está
  definitivamente morto, milhares de URLs são removidas com poucas requisições;
- URLs individuais são verificadas em rotação;
- 404/410 e outras falhas definitivas entram em quarentena;
- timeout e falhas transitórias não causam remoção;
- se todas as variantes de uma mídia forem removidas, a mídia sai do catálogo.

O arquivo `health-cache.json` no branch de publicação é estado interno da
sanitização. O arquivo consumido pelos players continua sendo apenas
`list.m3u8`.

## Cloudflare Worker

O Worker `l` mantém um endereço estável para os players. `/list.m3u8`,
`/live.m3u8` e `/vod.m3u8` retornam um redirecionamento HTTP 307 para a
playlist mais recente do GitHub. Como o destino é sempre o mesmo branch de
publicação, qualquer regeneração fica disponível no Worker imediatamente, sem
redeploy e sem armazenar dezenas de megabytes na Cloudflare.
