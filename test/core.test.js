import test from "node:test";
import assert from "node:assert/strict";

import { normalizeName } from "../src/normalize.js";
import { parseExtinf, parseSaimoCatalog } from "../src/parsers.js";
import { mergeItem, renderLiveM3U } from "../src/catalog.js";
import { decodeConfig } from "../src/token.js";

test("normalizes quality labels and channel numbers", () => {
  assert.equal(normalizeName("SporTV2 FHD"), normalizeName("SPORTV 2"));
  assert.equal(normalizeName("Cinemax HD"), normalizeName("Cinemax"));
});

test("parses M3U metadata", () => {
  const item = parseExtinf('#EXTINF:-1 tvg-id="foo" tvg-name="Canal X" tvg-logo="logo.png" group-title="TV",Canal X HD');
  assert.equal(item.name, "Canal X");
  assert.equal(item.logo, "logo.png");
  assert.equal(item.group, "TV");
});

test("parses Saimo source order and headers", () => {
  const items = parseSaimoCatalog([
    "canal: Canal X",
    "logo: https://img/x.png",
    "fonte: https://one.test/live.m3u8",
    "referer: https://one.test/",
    "agente: TestUA",
    "fonte: https://two.test/live.m3u8"
  ].join("\n"), { id: "saimo" });

  assert.equal(items.length, 1);
  assert.equal(items[0].variants.length, 2);
  assert.equal(items[0].variants[0].referer, "https://one.test/");
  assert.equal(items[0].variants[1].url, "https://two.test/live.m3u8");
});

test("merges equal channels as fallback variants", () => {
  const map = new Map();
  mergeItem(map, {
    name: "Cinemax HD",
    logo: "",
    group: "Filmes",
    variants: [{ url: "https://a.test/cinemax.m3u8", origin: "a" }]
  });
  mergeItem(map, {
    name: "Cinemax",
    logo: "https://img.test/cinemax.png",
    group: "",
    variants: [{ url: "https://b.test/cinemax.m3u8", origin: "b" }]
  });

  const item = [...map.values()][0];
  assert.equal(item.variants.length, 2);
  assert.equal(item.logo, "https://img.test/cinemax.png");
});

test("renders resolver URL for channels with alternatives", () => {
  const body = renderLiveM3U([{
    name: "Canal X",
    logo: "",
    group: "TV",
    variants: [
      { url: "https://one.test/live.m3u8" },
      { url: "https://two.test/live.m3u8" }
    ]
  }], "https://lista.example");

  const url = body.trim().split("\n").at(-1);
  assert.match(url, /^https:\/\/lista\.example\/channel\//);

  const token = url.split("/").at(-1);
  const config = decodeConfig(token);
  assert.equal(config.v.length, 2);
});
