import test from "node:test";
import assert from "node:assert/strict";

import {
  artworkDescriptor,
  enrichArtwork,
  extractArtworkYear,
  normalizeArtworkTitle,
  scoreTmdbCandidate
} from "../src/artwork.js";

test("normaliza titulo de filme removendo ruido de release", () => {
  assert.equal(
    normalizeArtworkTitle("Duna (2021) 4K Dublado WEB-DL"),
    "duna"
  );
  assert.equal(extractArtworkYear("Duna (2021) 4K"), 2021);
});

test("reconhece episodio como serie e usa o titulo da serie", () => {
  const descriptor = artworkDescriptor({
    name: "Loki S01E01 1080p Dublado",
    seriesTitle: "Loki",
    group: "Séries | Disney+"
  });

  assert.equal(descriptor.kind, "tv");
  assert.equal(descriptor.query, "Loki");
  assert.equal(descriptor.normalized, "loki");
});

test("pontua correspondencia exata acima de titulo diferente", () => {
  const descriptor = {
    kind: "movie",
    query: "Dune",
    normalized: "dune",
    year: 2021
  };

  const exact = scoreTmdbCandidate(descriptor, {
    title: "Dune",
    original_title: "Dune",
    release_date: "2021-09-15"
  });
  const wrong = scoreTmdbCandidate(descriptor, {
    title: "Dune Drifter",
    original_title: "Dune Drifter",
    release_date: "2020-01-01"
  });

  assert.ok(exact > 0.9);
  assert.ok(exact > wrong);
});

test("enriquece capa via TMDB sem sobrescrever logo existente", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;

  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({
      results: [{
        id: 438631,
        title: "Dune",
        original_title: "Dune",
        release_date: "2021-09-15",
        poster_path: "/poster.jpg"
      }]
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };

  try {
    const items = [
      {
        name: "Dune (2021) 4K Dublado",
        group: "Filmes | Ficção científica",
        logo: ""
      },
      {
        name: "Com Capa",
        group: "Filmes | Ação",
        logo: "https://example.test/cover.jpg"
      }
    ];

    const result = await enrichArtwork(items, {}, {
      token: "test-token",
      maxLookups: 10,
      concurrency: 1,
      timeoutMs: 1000
    });

    assert.equal(calls, 1);
    assert.equal(items[0].logo, "https://image.tmdb.org/t/p/w500/poster.jpg");
    assert.equal(items[1].logo, "https://example.test/cover.jpg");
    assert.equal(result.report.items_enriched, 1);
    assert.equal(result.report.matched, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
