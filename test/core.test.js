import test from "node:test";
import assert from "node:assert/strict";

import { normalizeName } from "../src/normalize.js";
import {
  parseM3UText,
  parseSaimoCatalogText,
  parseSaimoBases,
  resolveSaimoSource,
  seriesBaseName,
  buildCardIndex,
  cardLookupKey,
  buildEnrichmentIndex,
  applyEnrichment,
  mergeCatalog,
  renderCompactM3U,
  validateCatalog
} from "../src/build.js";
import { probeVariant, sanitizeCatalog, streamPoolKey } from "../src/health.js";

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

test("sanitizador nunca faz requisicao ao Worker interno", async () => {
  let calls = 0;
  const result = await probeVariant(
    { url: "https://l.vsxk.workers.dev/channel/0123456789abcdefabcd" },
    async () => {
      calls += 1;
      throw new Error("o Worker jamais deve ser acessado pela auditoria");
    }
  );

  assert.equal(calls, 0);
  assert.equal(result.verdict, "unknown");
  assert.equal(result.reason, "internal-facade-skipped");
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


test("failover de TV usa sufixo m3u8 para ajudar detecção HLS", () => {
  const item = {
    name: "Canal X",
    section: "TV",
    group: "Notícias",
    variants: [
      { url: "https://a.test/live.txt" },
      { url: "https://b.test/live" }
    ]
  };
  const failover = {
    ids: new Map([[item, "0123456789abcdefabcd"]]),
    version: "abc123"
  };
  const rendered = renderCompactM3U([item], {
    workerOrigin: "https://l.vsxk.workers.dev",
    failoverIndex: failover
  });

  assert.match(
    rendered.body,
    /https:\/\/l\.vsxk\.workers\.dev\/channel\/0123456789abcdefabcd\.m3u8\?v=abc123/
  );
});

test("failover VOD não ganha sufixo HLS artificial", () => {
  const item = {
    name: "Filme X",
    section: "Filmes",
    group: "Ação",
    variants: [
      { url: "https://a.test/movie.mp4" },
      { url: "https://b.test/movie.mp4" }
    ]
  };
  const failover = {
    ids: new Map([[item, "fedcba9876543210abcd"]]),
    version: "abc123"
  };
  const rendered = renderCompactM3U([item], {
    workerOrigin: "https://l.vsxk.workers.dev",
    failoverIndex: failover
  });

  assert.match(
    rendered.body,
    /https:\/\/l\.vsxk\.workers\.dev\/channel\/fedcba9876543210abcd\?v=abc123/
  );
  assert.doesNotMatch(rendered.body, /fedcba9876543210abcd\.m3u8/);
});
