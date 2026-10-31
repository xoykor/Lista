import test from "node:test";
import assert from "node:assert/strict";

import { normalizeName } from "../src/normalize.js";
import {
  parseM3UText,
  parseSaimoCatalogText,
  parseSaimoBases,
  resolveSaimoSource,
  parseSaimoGenresText,
  applySaimoGenreIndex,
  seriesBaseName,
  buildCardIndex,
  buildFailoverIndex,
  cardLookupKey,
  buildEnrichmentIndex,
  applyEnrichment,
  mergeCatalog,
  renderCompactM3U,
  validateCatalog
} from "../src/build.js";
import { probeVariant, sanitizeCatalog, streamPoolKey } from "../src/health.js";
import { parseIndiceDrawers, parseSeriesParts } from "../scripts/fetch-saimo.mjs";

test("normaliza nomes sem confundir qualidade com identidade", () => {
  assert.equal(normalizeName("SporTV2 FHD"), normalizeName("SPORTV 2"));
});

test("parseia M3U e classifica episodio como serie", () => {
  const rows = parseM3UText([
    "#EXTM3U",
    '#EXTINF:-1 group-title="BR | SERIES | NETFLIX",Loki S01E01',
    "https://cdn.test/series/loki/1.m3u8"
  ].join("\n"), { id: "ramys-vod", kind: "vod" });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].section, "Séries");
  assert.equal(rows[0].group, "Netflix");
});

test("parseia catalogo Saimo e descarta fonte ClearKey", () => {
  const rows = parseSaimoCatalogText([
    "canal: HBO",
    "categoria: Filmes e Séries",
    "fonte: https://protected.test/manifest.mpd",
    "chave: aa:bb",
    "fonte: https://open.test/live.m3u8"
  ].join("\n"), { id: "saimo-catalogo" });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].section, "TV");
  assert.equal(rows[0].variants.length, 1);
  assert.equal(rows[0].variants[0].url, "https://open.test/live.m3u8");
});

test("resolve formato compacto do VOD Saimo", () => {
  const bases = parseSaimoBases([
    "base: 0 https://movie.test/u/p/",
    "base: 1 https://series.test/u/p/"
  ].join("\n"));

  assert.equal(resolveSaimoSource("0:123", bases), "https://movie.test/u/p/123.mp4");
  assert.equal(resolveSaimoSource("1:master.m3u8", bases), "https://series.test/u/p/master.m3u8");
  assert.equal(
    resolveSaimoSource("https://cdn.test/a/master.txt", bases),
    "https://cdn.test/a/master.txt"
  );
});

test("usa generos publicados pelo Saimo em filmes e series", () => {
  const index = parseSaimoGenresText([
    "# tipo\ttítulo\tgêneros",
    "f\tFilme X (2024)\tAção,Aventura",
    "s\tLoki\tFicção científica,Drama"
  ].join("\n"));

  const rows = [
    {
      name: "Filme X (2024)",
      group: "Filmes",
      rawGroup: "Filmes",
      sectionHint: "Filmes",
      variants: [{ url: "https://movie.test/x.mp4" }]
    },
    {
      name: "Loki S01E01",
      seriesTitle: "Loki",
      group: "Séries",
      rawGroup: "Séries",
      sectionHint: "Séries",
      variants: [{ url: "https://series.test/loki.mp4" }]
    }
  ];

  assert.equal(applySaimoGenreIndex(rows, index), 2);
  assert.equal(rows[0].group, "Ação");
  assert.equal(rows[1].group, "Ficção Científica");
  assert.equal(index.report.movie_titles, 1);
  assert.equal(index.report.series_titles, 1);
});

test("extrai titulo-base de episodios entre formatos diferentes", () => {
  assert.equal(seriesBaseName("Loki S02E03"), "Loki");
  assert.equal(seriesBaseName("Loki 2x03 [DUB]"), "Loki");
  assert.equal(
    seriesBaseName("NETFLIX | Loki - Temporada 2 Episodio 3 [DUB]"),
    "Loki"
  );
});


test("enriquecimento cruza streaming entre fontes pelo titulo-base", () => {
  const items = [
    {
      name: "NETFLIX | Loki S01E01",
      seriesTitle: "Loki",
      rawGroup: "Séries | Netflix",
      group: "Netflix",
      section: "Séries",
      variants: [{ url: "https://ramys.test/1.m3u8", origin: "ramys-vod" }]
    },
    {
      name: "Loki S01E02",
      seriesTitle: "Loki",
      rawGroup: "Séries",
      group: "Outros",
      section: "Séries",
      variants: [{ url: "https://saimo.test/2.m3u8", origin: "saimo-vod" }]
    }
  ];

  const index = buildEnrichmentIndex(items);
  const report = {};
  applyEnrichment(items, index, report);

  assert.equal(items[1].group, "Netflix");
  assert.equal(report.enriched_series, 1);
});

test("enriquecimento nao inventa streaming quando fontes conflitam", () => {
  const items = [
    {
      name: "Show S01E01",
      seriesTitle: "Show",
      group: "Netflix",
      section: "Séries",
      variants: [{ url: "https://a.test/1.m3u8", origin: "a" }]
    },
    {
      name: "Show S01E02",
      seriesTitle: "Show",
      group: "Prime Video",
      section: "Séries",
      variants: [{ url: "https://b.test/2.m3u8", origin: "b" }]
    },
    {
      name: "Show S01E03",
      seriesTitle: "Show",
      group: "Outros",
      section: "Séries",
      variants: [{ url: "https://c.test/3.m3u8", origin: "c" }]
    }
  ];

  const index = buildEnrichmentIndex(items);
  applyEnrichment(items, index);
  assert.equal(items[2].group, "Outros");
});

test("merge preserva fallback mas produz um item canonico", () => {
  const rows = mergeCatalog([
    {
      name: "Filme X",
      group: "BR | FILMES | AÇÃO",
      kindHint: "vod",
      variants: [{ url: "https://one.test/movie/x.mp4", priority: 10 }]
    },
    {
      name: "Filme X",
      group: "Filmes",
      sectionHint: "Filmes",
      variants: [{ url: "https://two.test/movie/x.mp4", priority: 1 }]
    }
  ]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].section, "Filmes");
  assert.equal(rows[0].group, "Ação");
  assert.equal(rows[0].variants.length, 2);
});

test("render estatico escolhe URL direta sem Worker", () => {
  const rendered = renderCompactM3U([{
    name: "Loki S01E01",
    section: "Séries",
    group: "Disney+",
    variants: [{ url: "https://cdn.test/loki.mp4" }]
  }]);

  assert.match(rendered.body, /group-title="Séries \| Disney\+"/);
  assert.match(rendered.body, /https:\/\/cdn\.test\/loki\.mp4/);
  assert.doesNotMatch(rendered.body, /workers\.dev|\/channel\//);
});

test("validador recusa duplicata canonica", () => {
  const row = {
    name: "Canal X",
    section: "TV",
    group: "Outros",
    variants: [{ url: "https://a.test/x.m3u8" }]
  };
  assert.equal(validateCatalog([row]).ok, true);
  assert.equal(validateCatalog([row, { ...row }]).ok, false);
});

test("pool key agrupa conta IPTV e nao o ID final", () => {
  assert.equal(
    streamPoolKey("https://iptv.test/series/user/pass/123.mp4"),
    streamPoolKey("https://iptv.test/series/user/pass/999.mp4")
  );
});

test("sanitizacao remove pool definitivamente morto", async () => {
  const fakeFetch = async () => ({
    ok: false,
    status: 404,
    body: { cancel: async () => {} }
  });

  const result = await sanitizeCatalog([{
    name: "Morto",
    section: "Filmes",
    group: "Outros",
    variants: [{ url: "https://dead.test/movie/u/p/1.mp4" }]
  }], {
    fetchImpl: fakeFetch,
    poolSamplesCount: 1,
    itemProbeBudget: 0
  });

  assert.equal(result.items.length, 0);
  assert.equal(result.report.removed_items, 1);
});

test("timeout e falha transitoria nao removem item", async () => {
  const fakeFetch = async () => ({
    ok: false,
    status: 503,
    body: { cancel: async () => {} }
  });

  const result = await sanitizeCatalog([{
    name: "Instavel",
    section: "TV",
    group: "Outros",
    variants: [{ url: "https://unstable.test/live/x.m3u8" }]
  }], {
    fetchImpl: fakeFetch,
    poolSamplesCount: 1,
    itemProbeBudget: 0
  });

  assert.equal(result.items.length, 1);
});

test("host explicitamente desativado morre sem rede", async () => {
  const result = await probeVariant(
    { url: "http://desativado.invalid/a.mp4" },
    async () => { throw new Error("nao deveria chamar rede"); }
  );
  assert.equal(result.verdict, "dead");
});


test("probe rejeita VOD HTTP 200 absurdamente pequeno", async () => {
  const body = new Uint8Array(235);
  const result = await probeVariant(
    { url: "https://vod.test/series/u/p/180179.mp4" },
    async () => new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": "235"
      }
    })
  );

  assert.equal(result.verdict, "dead");
  assert.equal(result.reason, "media-too-small");
  assert.equal(result.bytes, 235);
});

test("probe rejeita HTTP 200 com tamanho zero", async () => {
  const result = await probeVariant(
    { url: "https://vod.test/series/u/p/empty.mp4" },
    async () => new Response(null, {
      status: 200,
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": "0"
      }
    })
  );

  assert.equal(result.verdict, "dead");
  assert.equal(result.reason, "empty-media");
});

test("probe aceita MP4 com assinatura ISO-BMFF", async () => {
  const body = new Uint8Array(64);
  body.set([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70], 0);

  const result = await probeVariant(
    { url: "https://vod.test/movie/u/p/ok.mp4" },
    async () => new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": "1048576"
      }
    })
  );

  assert.equal(result.verdict, "alive");
  assert.equal(result.reason, "mp4");
});

test("probe trata 403 como fonte definitivamente indisponivel", async () => {
  const result = await probeVariant(
    { url: "https://vod.test/series/u/p/blocked.mp4" },
    async () => new Response("<html>forbidden</html>", {
      status: 403,
      headers: { "Content-Type": "text/html" }
    })
  );

  assert.equal(result.verdict, "dead");
  assert.equal(result.status, 403);
});


test("preserva card artwork fora da M3U e publica ponte de metadados", () => {
  const item = {
    name: "Filme X",
    section: "Filmes",
    group: "Ação",
    logo: "https://img.test/x.jpg",
    variants: [{ url: "https://cdn.test/x.mp4" }]
  };

  const cards = buildCardIndex([item]);
  const key = cardLookupKey("Filme X", "Filmes | Ação");
  assert.equal(cards.rows.get(key), "https://img.test/x.jpg");

  const rendered = renderCompactM3U([item], {
    cardIndexBase: "https://raw.test/cards",
    cardIndexVersion: cards.version
  });

  assert.match(rendered.body, /#EXT-X-LISTA-CARDS:https:\/\/raw\.test\/cards/);
  assert.match(rendered.body, /#EXT-X-LISTA-CARDS-VERSION:/);
  assert.doesNotMatch(rendered.body, /#EXT-X-LISTA-CARDS-SHARD-LEN:/);
  assert.doesNotMatch(rendered.body, /tvg-logo=/);

  const fine = renderCompactM3U([item], {
    cardIndexBase: "https://raw.test/cards",
    cardIndexVersion: cards.version,
    cardIndexShardLength: 2
  });
  assert.match(fine.body, /#EXT-X-LISTA-CARDS-SHARD-LEN:2/);
});


test("playlist canônica usa URL direta e metadado de fallback estático", () => {
  const item = {
    name: "Canal X",
    section: "TV",
    group: "Notícias",
    variants: [
      { url: "https://a.test/live.m3u8", referer: "https://ref.test/" },
      { url: "https://b.test/live.m3u8" }
    ]
  };
  const failover = {
    ids: new Map([[item, "0123456789abcdefabcd"]]),
    version: "abc123"
  };
  const rendered = renderCompactM3U([item], {
    failoverIndex: failover,
    fallbackIndexBase: "https://raw.githubusercontent.com/xoykor/Lista/static-fallback/fallback",
    fallbackIndexVersion: failover.version,
    fallbackIndexShardLength: 2
  });

  assert.match(rendered.body, /#EXT-X-LISTA-FALLBACK:https:\/\/raw\.githubusercontent\.com\/xoykor\/Lista\/static-fallback\/fallback/);
  assert.match(rendered.body, /#EXT-X-LISTA-FALLBACK-VERSION:abc123/);
  assert.match(rendered.body, /#EXT-X-LISTA-FALLBACK-SHARD-LEN:2/);
  assert.match(rendered.body, /x-lista-fallback="0123456789abcdefabcd"/);
  assert.match(rendered.body, /https:\/\/a\.test\/live\.m3u8/);
  assert.match(rendered.body, /#EXTVLCOPT:http-referrer=https:\/\/ref\.test\//);
  assert.doesNotMatch(rendered.body, /workers\.dev|\/channel\//);
});

test("fallback estático preserva headers das variantes", () => {
  const item = {
    name: "Filme X",
    section: "Filmes",
    group: "Ação",
    variants: [
      {
        url: "https://a.test/movie.mp4",
        origin: "a",
        referer: "https://ref.test/",
        userAgent: "Player/1.0"
      },
      { url: "https://b.test/movie.mp4", origin: "b" }
    ]
  };

  const failover = buildFailoverIndex([item], { maxVariants: 6 });
  const id = failover.ids.get(item);
  const row = failover.shards.get(id.slice(0, 2))[id];

  assert.deepEqual(row[0], [
    "https://a.test/movie.mp4",
    "a",
    "https://ref.test/",
    "Player/1.0"
  ]);
});

test("resolveSaimoSource descarta relays saimo-tv e placeholders falsos", () => {
  const bases = parseSaimoBases([
    "base: 0 https://dbonline.tech-cdn.top:443/movie/1231214125/432345435/",
    "base: 1 https://passing-melinda-onomed1-d0cbec40.koyeb.app/"
  ].join("\n"));

  assert.equal(
    resolveSaimoSource("https://saimo-tv.pages.dev/api/stream?type=series&tmdb=1&s=1&e=1", bases),
    ""
  );
  assert.equal(
    resolveSaimoSource("1:stream/51389?hash=7c7b56d63625f6546e0cb6d0", bases),
    ""
  );
  assert.equal(
    resolveSaimoSource("0:46380", bases),
    "https://dbonline.tech-cdn.top:443/movie/1231214125/432345435/46380.mp4"
  );
});

test("injeta Referer automatico para variantes embedplayer2.xyz", () => {
  const rows = mergeCatalog([{
    name: "Loki S01E01",
    group: "Séries",
    sectionHint: "Séries",
    variants: [{ url: "https://embedplayer2.xyz/cdn/down/disk5/123/index.m3u8", origin: "saimo-vod" }]
  }]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].variants[0].referer, "https://embedplayer2.xyz/");
});

test("hosts VOD mortos (corruptx e acaidopt VOD) morrem sem rede", async () => {
  const noNetwork = async () => {
    throw new Error("nao deveria chamar rede");
  };

  const corruptx = await probeVariant(
    { url: "http://corruptx.org:80/series/721728148/751428971/177770.mp4" },
    noNetwork
  );
  assert.equal(corruptx.verdict, "dead");

  const acaidoptVod = await probeVariant(
    { url: "http://acaidopt.org:80/series/H54715/274393/198431.mp4" },
    noNetwork
  );
  assert.equal(acaidoptVod.verdict, "dead");
});

test("sanitizacao remove pool com 2 amostras mortas e 1 timeout", async () => {
  let calls = 0;
  const fakeFetch = async () => {
    calls += 1;
    if (calls <= 2) {
      return {
        ok: false,
        status: 404,
        body: { cancel: async () => {} }
      };
    }
    throw new Error("network timeout");
  };

  const result = await sanitizeCatalog([
    {
      name: "Ep 1",
      section: "Séries",
      group: "Outros",
      variants: [{ url: "https://deadpool.test/series/u/p/1.mp4" }]
    },
    {
      name: "Ep 2",
      section: "Séries",
      group: "Outros",
      variants: [{ url: "https://deadpool.test/series/u/p/2.mp4" }]
    },
    {
      name: "Ep 3",
      section: "Séries",
      group: "Outros",
      variants: [{ url: "https://deadpool.test/series/u/p/3.mp4" }]
    }
  ], {
    fetchImpl: fakeFetch,
    poolSamplesCount: 3,
    itemProbeBudget: 0
  });

  assert.equal(result.items.length, 0);
  assert.equal(result.report.dead_pools.length, 1);
});

test("parseIndiceDrawers e parseSeriesParts extraem arquivos do Saimo", () => {
  const drawers = parseIndiceDrawers([
    "base: 0 https://dbonline.tech-cdn.top:443/movie/u/p/",
    "#\t120\t45",
    "A\t2300\t180"
  ].join("\n"));

  assert.deepEqual(drawers, [
    { letter: "#", movies: 120, series: 45 },
    { letter: "A", movies: 2300, series: 180 }
  ]);

  const parts = parseSeriesParts([
    "A Casa do Dragão\t2\t0\t1",
    "A Outra Série\t3\t1\t0"
  ].join("\n"));

  assert.deepEqual(parts, [0, 1]);
});

test("poolSamples espalha amostras pelo pool e nao mata pool vivo por 3 itens iniciais 404", async () => {
  const items = Array.from({ length: 60 }, (_, idx) => ({
    name: `Serie S01E${String(idx + 1).padStart(2, "0")}`,
    section: "Séries",
    group: "Netflix",
    variants: [{ url: `https://bigpool.test/series/u/p/${idx + 1}.mp4` }]
  }));

  const body = new Uint8Array(64);
  body.set([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70], 0);

  const fakeFetch = async (url) => {
    const u = String(url);
    // Primeiros 5 itens retornam 404, resto retorna 206 MP4 válido.
    if (/\/[1-5]\.mp4$/.test(u)) {
      return new Response("not found", { status: 404 });
    }
    return new Response(body, {
      status: 206,
      headers: {
        "Content-Type": "video/mp4",
        "Content-Range": "bytes 0-63/10485760"
      }
    });
  };

  const result = await sanitizeCatalog(items, {
    fetchImpl: fakeFetch,
    poolSamplesCount: 3,
    itemProbeBudget: 0
  });

  assert.equal(result.report.dead_pools.length, 0);
  assert.equal(result.items.length, 60);
});

test("mergeCatalog prioriza MP4 direto acima de master.txt do embedplayer e ordena episodios crescente", () => {
  const rows = mergeCatalog([
    {
      name: "Frieren e a Jornada para o Além S01E02",
      seriesTitle: "Frieren e a Jornada para o Além",
      group: "Séries | Crunchyroll",
      sectionHint: "Séries",
      variants: [
        {
          url: "https://embedplayer2.xyz/cdn/hls/ee6ea30955adfd17425a5d990c223efa/master.txt",
          language: "dub",
          priority: 1
        },
        {
          url: "http://dbonline.tech-cdn.top:80/series/ke-vin-0928392083/PZjF6XATTZ/37931.mp4",
          language: "dub",
          priority: 8
        }
      ]
    },
    {
      name: "Frieren e a Jornada para o Além S01E01",
      seriesTitle: "Frieren e a Jornada para o Além",
      group: "Séries | Crunchyroll",
      sectionHint: "Séries",
      variants: [
        {
          url: "http://dbonline.tech-cdn.top:80/series/ke-vin-0928392083/PZjF6XATTZ/37930.mp4",
          language: "dub",
          priority: 8
        }
      ]
    }
  ]);

  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, "Frieren e a Jornada para o Além S01E01");
  assert.equal(rows[1].name, "Frieren e a Jornada para o Além S01E02");
  assert.equal(
    rows[1].variants[0].url,
    "http://dbonline.tech-cdn.top:80/series/ke-vin-0928392083/PZjF6XATTZ/37931.mp4"
  );
});
