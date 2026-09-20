// SPDX-License-Identifier: MIT
import test from "node:test";
import assert from "node:assert/strict";

import {
  canonicalizeCatalogItems,
  classifyTaxonomy,
  orderCatalogByTaxonomy
} from "../src/taxonomy.js";

function item(name, group, kindHint = "") {
  return {
    name,
    group,
    kindHint,
    logo: "",
    variants: [{ url: "https://cdn.test/video.mp4" }]
  };
}

test("normaliza generos de filmes", () => {
  for (const group of [
    "BR | FILMES | AÇÃO",
    "Filmes - Ação",
    "VOD: ACAO",
    "AÇÃO FILMES"
  ]) {
    assert.deepEqual(
      classifyTaxonomy(item("Filme X", group, "vod")),
      { section: "Filmes", category: "Ação" }
    );
  }
});

test("series usam streaming quando upstream informa", () => {
  assert.deepEqual(
    classifyTaxonomy(item("Loki S02E03", "SERIES | DISNEY PLUS", "vod")),
    { section: "Séries", category: "Disney+" }
  );
  assert.deepEqual(
    classifyTaxonomy(item("Dark S01E01", "NETFLIX | SERIES", "vod")),
    { section: "Séries", category: "Netflix" }
  );
});

test("anime e dorama continuam separaveis", () => {
  assert.deepEqual(
    classifyTaxonomy(item("Show S01E01", "SERIES | ANIME", "vod")),
    { section: "Séries", category: "Anime" }
  );
  assert.deepEqual(
    classifyTaxonomy(item("Show S01E01", "DORAMAS", "vod")),
    { section: "Séries", category: "Doramas" }
  );
});

test("fonte marcada live permanece TV mesmo com nome de cinema", () => {
  assert.deepEqual(
    classifyTaxonomy(item("HBO", "FILMES E SÉRIES", "live")),
    { section: "TV", category: "Entretenimento" }
  );
});

test("normaliza categorias de TV", () => {
  assert.deepEqual(
    classifyTaxonomy(item("CNN Brasil", "BR | NOTICIAS", "live")),
    { section: "TV", category: "Notícias" }
  );
  assert.deepEqual(
    classifyTaxonomy(item("ESPN 2", "ESPN", "live")),
    { section: "TV", category: "Esportes" }
  );
});

test("ordenacao segue TV, Filmes e Series", () => {
  const rows = [
    item("Serie S01E01", "SERIES | COMEDIA", "vod"),
    item("Filme", "FILMES | TERROR", "vod"),
    item("Canal", "TV ABERTA", "live")
  ];
  canonicalizeCatalogItems(rows);

  assert.deepEqual(
    orderCatalogByTaxonomy(rows).map((row) => [row.section, row.group]),
    [
      ["TV", "Abertos"],
      ["Filmes", "Terror"],
      ["Séries", "Comédia"]
    ]
  );
});
