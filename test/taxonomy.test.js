// SPDX-License-Identifier: MIT
import test from "node:test";
import assert from "node:assert/strict";

import {
  canonicalizeCatalogItems,
  classifyTaxonomy,
  orderCatalogByTaxonomy
} from "../src/taxonomy.js";
import { renderStaticDirectM3U } from "../src/catalog.js";

function item(name, group, url = "https://cdn.test/video.mp4", variant = {}) {
  return {
    name,
    group,
    logo: "",
    variants: [{ url, ...variant }]
  };
}

test("normalizes common movie group spellings into one canonical genre", () => {
  for (const group of [
    "BR | FILMES | AÇÃO",
    "Filmes - Ação",
    "VOD: ACAO",
    "AÇÃO FILMES"
  ]) {
    assert.deepEqual(
      classifyTaxonomy(item("Filme X", group)),
      { section: "Filmes", category: "Ação" },
      group
    );
  }
});

test("normalizes series genres and episode syntax", () => {
  assert.deepEqual(
    classifyTaxonomy(item("Show X", "BR | SERIES | ANIME", "https://cdn.test/series/x/1.m3u8")),
    { section: "Séries", category: "Anime" }
  );

  assert.deepEqual(
    classifyTaxonomy(item("Loki S02E03", "Canais | Disney +", "https://cdn.test/loki/3.m3u8")),
    { section: "Séries", category: "Outros" }
  );
});

test("keeps known live providers in TV even when editorial group says Filmes", () => {
  assert.deepEqual(
    classifyTaxonomy(item(
      "AMC",
      "FILMES E SÉRIES",
      "https://cdn.test/amc.m3u8",
      { origin: "saimo-catalogo" }
    )),
    { section: "TV", category: "Entretenimento" }
  );

  assert.deepEqual(
    classifyTaxonomy({
      name: "Pluto Cinema",
      group: "Filmes",
      variants: [{ provider: "pluto", channelId: "abc", origin: "pluto-br" }]
    }),
    { section: "TV", category: "Entretenimento" }
  );
});

test("normalizes live TV categories", () => {
  assert.deepEqual(
    classifyTaxonomy(item("CNN Brasil", "BR | NOTICIAS", "https://cdn.test/live/cnn.m3u8")),
    { section: "TV", category: "Notícias" }
  );

  assert.deepEqual(
    classifyTaxonomy(item("ESPN 2", "ESPN", "https://cdn.test/live/espn.m3u8")),
    { section: "TV", category: "Esportes" }
  );
});

test("canonicalization mutates in place and taxonomy ordering is section/category stable", () => {
  const rows = [
    item("Filme", "FILMES | TERROR"),
    item("Canal", "TV ABERTA", "https://cdn.test/live/canal.m3u8"),
    item("Série S01E01", "SERIES | COMEDIA", "https://cdn.test/series/show/1.m3u8")
  ];

  const result = canonicalizeCatalogItems(rows);
  assert.equal(result.items, rows);

  const ordered = orderCatalogByTaxonomy(rows);
  assert.deepEqual(
    ordered.map((row) => [row.section, row.group]),
    [
      ["TV", "Abertos"],
      ["Filmes", "Terror"],
      ["Séries", "Comédia"]
    ]
  );
});

test("renderer publishes canonical section plus category metadata", () => {
  const rows = [item("Filme X", "BR | FILMES | AÇÃO")];
  canonicalizeCatalogItems(rows);

  const rendered = renderStaticDirectM3U(rows).body;
  assert.match(rendered, /group-title="Filmes \| Ação"/);
  assert.match(rendered, /x-lista-section="Filmes"/);
  assert.match(rendered, /x-lista-category="Ação"/);
});
