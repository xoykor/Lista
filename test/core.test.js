import test from "node:test";
import assert from "node:assert/strict";

import { normalizeName } from "../src/normalize.js";
import { parseExtinf, parseSaimoCatalog } from "../src/parsers.js";
import { mergeItem, renderLiveM3U } from "../src/catalog.js";
import { decodeConfig } from "../src/token.js";
import {
  fetchPlutoCatalog,
  resolvePlutoStream
} from "../src/providers/pluto.js";

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

test("renders Pluto as a dynamic provider token, not an expiring HLS URL", () => {
  const body = renderLiveM3U([{
    name: "Pluto Test",
    logo: "",
    group: "Pluto TV",
    variants: [{
      provider: "pluto",
      channelId: "channel_123",
      origin: "pluto-br"
    }]
  }], "https://lista.example");

  const url = body.trim().split("\n").at(-1);
  const token = url.split("/").at(-1);
  const config = decodeConfig(token);

  assert.equal(config.v[0].p, "pluto");
  assert.equal(config.v[0].c, "channel_123");
  assert.equal(config.v[0].u, undefined);
});

test("parses Pluto guide into provider-backed channels", async () => {
  const tokenPayload = btoa(JSON.stringify({ exp: 1900000000 }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  const jwt = "x." + tokenPayload + ".y";

  const mockFetch = async (input) => {
    const url = String(input);
    if (url.startsWith("https://boot.pluto.tv/")) {
      return new Response(JSON.stringify({
        sessionToken: jwt,
        stitcherParams: "deviceType=web",
        servers: { stitcher: "https://stitcher.test" }
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    if (url.startsWith("https://service-channels.clusters.pluto.tv/")) {
      return new Response(JSON.stringify({
        data: [{
          id: "pluto123",
          name: "Pluto Test",
          category: "Filmes",
          images: [{
            type: "colorLogoPNG",
            url: "https://img.test/pluto.png"
          }]
        }]
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    throw new Error("unexpected URL: " + url);
  };

  const items = await fetchPlutoCatalog({ id: "pluto-br" }, mockFetch);
  assert.equal(items.length, 1);
  assert.equal(items[0].name, "Pluto Test");
  assert.equal(items[0].group, "Filmes");
  assert.equal(items[0].variants[0].provider, "pluto");
  assert.equal(items[0].variants[0].channelId, "pluto123");
});

test("builds fresh authenticated Pluto stream URLs on demand", async () => {
  const tokenPayload = btoa(JSON.stringify({ exp: 1900000000 }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  const jwt = "x." + tokenPayload + ".y";

  const mockFetch = async () => new Response(JSON.stringify({
    sessionToken: jwt,
    stitcherParams: "deviceType=web&foo=bar",
    servers: { stitcher: "https://stitcher.test/" }
  }), { status: 200, headers: { "Content-Type": "application/json" } });

  const resolved = await resolvePlutoStream("pluto123", mockFetch);
  const url = new URL(resolved.url);

  assert.equal(url.origin, "https://stitcher.test");
  assert.match(url.pathname, /\/v2\/stitch\/hls\/channel\/pluto123\/master\.m3u8$/);
  assert.equal(url.searchParams.get("jwt"), jwt);
  assert.equal(url.searchParams.get("masterJWTPassthrough"), "true");
  assert.equal(url.searchParams.get("foo"), "bar");
});
