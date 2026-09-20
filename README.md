# Lista

Uma única playlist M3U regenerada automaticamente a partir de:

- `gabrielsaimo/SaimoPlayer`
- `Ramys/Iptv-Brasil-2026`

Playlist pública:

`https://raw.githubusercontent.com/xoykor/Lista/static-fallback/list.m3u8`

## Arquitetura

O catálogo é construído inteiramente no GitHub Actions. O Cloudflare Workers não
participa da geração, da sanitização, do armazenamento nem da reprodução da
playlist; portanto a regeneração normal faz **0 requisições ao Worker**.

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

O workflow roda a cada 3 horas e também quando o gerador muda.

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
