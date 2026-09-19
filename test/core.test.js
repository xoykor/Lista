import test from "node:test";
import assert from "node:assert/strict";

import { normalizeName } from "../src/normalize.js";
import { parseExtinf, parseSaimoCatalog } from "../src/parsers.js";
import { mergeItem, renderLiveM3U } from "../src/catalog.js";
import { verifyConfig } from "../src/token.js";
import { fetchVariant, looksLikePlaylist } from "../src/hls.js";
import { pruneDeadStreamPools, streamPoolKey } from "../src/health.js";
import {
  fetchPlutoCatalog,
  resolvePlutoStream
} from "../src/providers/pluto.js";

const TOKEN_SECRET = "test-secret-for-signed-resolver-tokens";

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

test("drops Saimo variants marked with ClearKey but keeps ordinary fallbacks", () => {
  const items = parseSaimoCatalog([
    "canal: Canal X",
    "fonte: https://protected.test/manifest.mpd",
    "referer: https://protected.test/",
    "chave: 001122:334455",
    "fonte: https://open.test/live.m3u8"
  ].join("\n"), { id: "saimo" });

  assert.equal(items.length, 1);
  assert.equal(items[0].variants.length, 1);
  assert.equal(items[0].variants[0].url, "https://open.test/live.m3u8");
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

test("renders signed resolver URL for channels with alternatives", async () => {
  const body = await renderLiveM3U([{
    name: "Canal X",
    logo: "",
    group: "TV",
    variants: [
      { url: "https://one.test/live.m3u8" },
      { url: "https://two.test/live.m3u8" }
    ]
  }], "https://lista.example", TOKEN_SECRET);

  const url = body.trim().split("\n").at(-1);
  assert.match(url, /^https:\/\/lista\.example\/channel\//);

  const token = url.split("/").at(-1);
  assert.match(token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

  const config = await verifyConfig(token, TOKEN_SECRET);
  assert.equal(config.v.length, 2);
});

test("rejects resolver token signed with another secret", async () => {
  const body = await renderLiveM3U([{
    name: "Canal X",
    logo: "",
    group: "TV",
    variants: [
      { url: "https://one.test/live.m3u8" },
      { url: "https://two.test/live.m3u8" }
    ]
  }], "https://lista.example", TOKEN_SECRET);

  const token = body.trim().split("\n").at(-1).split("/").at(-1);
  await assert.rejects(
    verifyConfig(token, "different-secret"),
    /invalid signature/
  );
});

test("renders Pluto as a dynamic signed provider token", async () => {
  const body = await renderLiveM3U([{
    name: "Pluto Test",
    logo: "",
    group: "Pluto TV",
    variants: [{
      provider: "pluto",
      channelId: "channel_123",
      origin: "pluto-br"
    }]
  }], "https://lista.example", TOKEN_SECRET);

  const url = body.trim().split("\n").at(-1);
  const token = url.split("/").at(-1);
  const config = await verifyConfig(token, TOKEN_SECRET);

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


test("recognizes text playlist wrappers", () => {
  assert.equal(
    looksLikePlaylist("https://cdn.test/channel/ae.txt", "text/plain"),
    true
  );
});

test("resolves txt URL wrappers before handing media to the player", async () => {
  const seen = [];

  const mockFetch = async (input, options) => {
    const url = String(input);
    seen.push({
      url,
      referer: options.headers.get("Referer"),
      userAgent: options.headers.get("User-Agent")
    });

    if (url === "https://wrapper.test/ae.txt") {
      return new Response("https://media.test/live/master.m3u8\n", {
        status: 200,
        headers: { "Content-Type": "text/plain" }
      });
    }

    if (url === "https://media.test/live/master.m3u8") {
      return new Response("#EXTM3U\n#EXTINF:5,\nseg-1.ts\n", {
        status: 200,
        headers: { "Content-Type": "application/vnd.apple.mpegurl" }
      });
    }

    throw new Error("unexpected URL: " + url);
  };

  const result = await fetchVariant({
    u: "https://wrapper.test/ae.txt",
    r: "https://wrapper.test/",
    a: "Lista-Test-UA"
  }, mockFetch);

  assert.equal(result.ok, true);
  assert.equal(result.redirect, undefined);
  assert.match(result.playlist, /https:\/\/media\.test\/live\/seg-1\.ts/);
  assert.equal(seen.length, 2);
  assert.equal(seen[0].referer, "https://wrapper.test/");
  assert.equal(seen[1].referer, "https://wrapper.test/");
  assert.equal(seen[1].userAgent, "Lista-Test-UA");
});

test("reads an HLS manifest served directly as txt", async () => {
  const mockFetch = async () => new Response(
    "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\nvariant/index.m3u8\n",
    {
      status: 200,
      headers: { "Content-Type": "text/plain" }
    }
  );

  const result = await fetchVariant({
    u: "https://wrapper.test/ae.txt"
  }, mockFetch);

  assert.equal(result.ok, true);
  assert.match(
    result.playlist,
    /https:\/\/wrapper\.test\/variant\/index\.m3u8/
  );
});


test("groups Xtream-style URLs by account pool", () => {
  assert.equal(
    streamPoolKey("http://host.test/live/user/pass/1001.ts"),
    "host.test/live/user/pass"
  );
  assert.equal(
    streamPoolKey("http://host.test/live/user/pass/1002.ts"),
    "host.test/live/user/pass"
  );
  assert.equal(
    streamPoolKey("http://host.test/user/pass/1003.ts"),
    "host.test/user/pass"
  );
});

test("preflight removes an entirely dead stream pool before publication", async () => {
  const items = [
    {
      name: "Canal A",
      variants: [{ url: "http://dead.test/live/u/p/1.ts" }]
    },
    {
      name: "Canal B",
      variants: [{ url: "http://dead.test/live/u/p/2.ts" }]
    },
    {
      name: "Canal C",
      variants: [{ url: "http://ok.test/live/u/p/3.ts" }]
    }
  ];

  const mockFetch = async (input) => {
    const url = String(input);
    if (url.includes("dead.test")) {
      return new Response("bad", { status: 404 });
    }
    return new Response("x", {
      status: 200,
      headers: { "Content-Type": "video/mp2t" }
    });
  };

  const result = await pruneDeadStreamPools(items, {
    fetchImpl: mockFetch,
    minPoolSize: 1,
    sampleCount: 3,
    concurrency: 2
  });

  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].name, "Canal C");
  assert.equal(result.report.pools_dead, 1);
  assert.equal(result.report.removed_items, 2);
});
