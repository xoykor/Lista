# Lista

Uma única playlist M3U regenerada automaticamente a partir de:

- `gabrielsaimo/SaimoPlayer`
- `Ramys/Iptv-Brasil-2026`

Playlist pública:

`https://raw.githubusercontent.com/xoykor/Lista/static-fallback/list.m3u8`

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
9. publica shards estáticos de fallback e cards no branch `static-fallback`.

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
fallback/
cards/
```

`list.m3u8` é o único arquivo obrigatório para players M3U comuns. Os
diretórios `fallback/` e `cards/` são metadados adicionais para clientes
compatíveis.
