// SPDX-License-Identifier: MIT

/*
 * Worker de failover leve.
 *
 * O catálogo e os índices continuam no GitHub. Itens com uma única fonte saem
 * da playlist com URL direta e não tocam o Worker. Só itens com duas ou mais
 * fontes compatíveis usam /channel/<id>, portanto o custo do Worker fica
 * restrito aos casos em que o fallback realmente pode ser útil.
 */

const RAW_BASE =
  "https://raw.githubusercontent.com/xoykor/Lista/static-fallback";
const SOURCE_CACHE_TTL_SECONDS = 120;
const SHARD_CACHE_TTL_SECONDS = 300;
const PROBE_TIMEOUT_MS = 3500;

function json(value, status = 200) {
  return new Response(JSON.stringify(value, null, 2) + "\n", {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*"
    }
  });
}

function redirect(location, extra = {}) {
  return new Response(null, {
    status: 307,
    headers: {
      Location: location,
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      ...extra
    }
  });
}

function timeoutSignal(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("timeout"), ms);
  return {
    signal: controller.signal,
    cancel: () => clearTimeout(timer)
  };
}

async function loadShard(id, version) {
  const shard = id.slice(0, 2);
  const url =
    RAW_BASE +
    "/fallback/" +
    shard +
    ".json?v=" +
    encodeURIComponent(version || "current");

  const response = await fetch(url, {
    headers: {
      "Accept": "application/json",
      "User-Agent": "Lista-Failover/1.0"
    },
    cf: {
      cacheEverything: true,
      cacheTtl: SHARD_CACHE_TTL_SECONDS
    }
  });

  if (!response.ok) return null;

  try {
    const rows = await response.json();
    const variants = rows?.[id];
    return Array.isArray(variants) ? variants : null;
  } catch {
    return null;
  }
}

async function probe(url) {
  const timer = timeoutSignal(PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      headers: {
        "Accept": "*/*",
        "Range": "bytes=0-2047",
        "User-Agent": "Mozilla/5.0 (compatible; Lista-Failover/1.0)"
      },
      signal: timer.signal,
      cf: {
        cacheTtl: 0,
        cacheEverything: false
      }
    });

    const alive =
      response.ok ||
      response.status === 206 ||
      response.status === 416;

    const finalUrl = response.url || url;
    try { await response.body?.cancel(); } catch {}

    return alive ? finalUrl : "";
  } catch {
    return "";
  } finally {
    timer.cancel();
  }
}

function selectedCacheKey(id, version) {
  return new Request(
    "https://lista-failover.invalid/selected/" +
      id +
      "?v=" +
      encodeURIComponent(version || "current")
  );
}

async function cachedSelection(id, version) {
  const cached = await caches.default.match(selectedCacheKey(id, version));
  if (!cached) return "";
  return (await cached.text()).trim();
}

async function saveSelection(id, version, url) {
  const response = new Response(url, {
    headers: {
      "Cache-Control": "public, max-age=" + SOURCE_CACHE_TTL_SECONDS,
      "Content-Type": "text/plain; charset=utf-8"
    }
  });
  await caches.default.put(selectedCacheKey(id, version), response);
}

async function resolveChannel(id, version) {
  const remembered = await cachedSelection(id, version);
  if (remembered) {
    return { url: remembered, sourceIndex: -1, cached: true };
  }

  const variants = await loadShard(id, version);
  if (!variants?.length) return null;

  for (let index = 0; index < variants.length; index += 1) {
    const value = variants[index];
    const url = Array.isArray(value) ? value[0] : "";
    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) continue;

    const alive = await probe(url);
    if (!alive) continue;

    await saveSelection(id, version, alive);
    return { url: alive, sourceIndex: index, cached: false };
  }

  return null;
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/" && (request.method === "GET" || request.method === "HEAD")) {
      if (request.method === "HEAD") return new Response(null, { status: 200 });
      return json({
        service: "Lista",
        list: "/list.m3u8",
        status: "/status.json",
        health: "/healthz",
        source: RAW_BASE + "/list.m3u8",
        mode: "static-list-with-selective-runtime-failover",
        generation_on_cloudflare: false,
        storage_on_cloudflare: false
      });
    }

    if (url.pathname === "/healthz" && (request.method === "GET" || request.method === "HEAD")) {
      return new Response(request.method === "HEAD" ? null : "ok\n", {
        status: 200,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store"
        }
      });
    }

    if (
      (url.pathname === "/list.m3u8" ||
       url.pathname === "/list-samsung.m3u8" ||
       url.pathname === "/live.m3u8" ||
       url.pathname === "/vod.m3u8") &&
      (request.method === "GET" || request.method === "HEAD")
    ) {
      return redirect(RAW_BASE + "/list.m3u8");
    }

    if (url.pathname === "/status.json" && (request.method === "GET" || request.method === "HEAD")) {
      return redirect(RAW_BASE + "/status.json");
    }

    const channel = url.pathname.match(/^\/channel\/([a-f0-9]{20})$/i);
    if (channel && (request.method === "GET" || request.method === "HEAD")) {
      const id = channel[1].toLowerCase();
      const version = url.searchParams.get("v") || "current";
      const resolved = await resolveChannel(id, version);

      if (!resolved) {
        return new Response("all sources failed\n", {
          status: 502,
          headers: {
            "Cache-Control": "no-store",
            "Access-Control-Allow-Origin": "*"
          }
        });
      }

      return redirect(resolved.url, {
        "X-Lista-Fallback": resolved.cached ? "cached" : "resolved",
        "X-Lista-Source-Index": String(resolved.sourceIndex)
      });
    }

    return new Response("not found\n", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8" }
    });
  }
};


