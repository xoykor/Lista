import test from "node:test";
import assert from "node:assert/strict";

import { normalizeName } from "../src/normalize.js";
import {
  parseM3UText,
  parseSaimoCatalogText,
  parseSaimoBases,
  resolveSaimoSource,
  seriesBaseName,
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

test("extrai titulo-base de episodios", () => {
  assert.equal(seriesBaseName("Loki S02E03"), "Loki");
  assert.equal(seriesBaseName("Loki 2x03 [DUB]"), "Loki");
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
