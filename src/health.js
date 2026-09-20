// SPDX-License-Identifier: MIT
import { createHash } from "node:crypto";

const DEFINITIVE_DEAD = new Set([400, 401, 403, 404, 410, 451, 502, 508]);
const KNOWN_DEAD_HOSTS = new Set(["desativado.invalid"]);

function compactHeaders(variant) {
  const headers = {
    "User-Agent": variant.userAgent || "Lista-Auto-Healing/2.0",
    "Accept": "*/*"
  };
  if (variant.referer) headers.Referer = variant.referer;
  return headers;
}

const MEDIA_SAMPLE_BYTES = 4096;
const MIN_VOD_BYTES = 16 * 1024;

function responseHeader(response, name) {
  try {
    return String(response?.headers?.get?.(name) || "").trim();
  } catch {
    return "";
  }
}

function reportedResponseLength(response) {
  const contentRange = responseHeader(response, "Content-Range");
  const rangeMatch = contentRange.match(/\/(\d+)\s*$/);
  if (rangeMatch) return Number(rangeMatch[1]);

  // Em 206, Content-Length normalmente descreve só o pedaço solicitado.
  if (Number(response?.status) === 206) return null;

  const contentLengthRaw = responseHeader(response, "Content-Length");
  if (!contentLengthRaw) return null;

  const contentLength = Number(contentLengthRaw);
  return Number.isFinite(contentLength) && contentLength >= 0
    ? contentLength
    : null;
}

function isLikelyVodUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const path = url.pathname.toLowerCase();
    return (
      /\.(?:mp4|m4v|mov|mkv|webm|avi|flv|wmv|mpg|mpeg)$/.test(path) ||
      path.includes("/movie/") ||
      path.includes("/series/") ||
      path.includes("/vod/")
    );
  } catch {
    return false;
  }
}

function sampleHead(sample) {
  return Buffer.from(sample || []).subarray(0, 4096);
}

function looksLikeHtmlOrJson(contentType, sample) {
  const ct = String(contentType || "").toLowerCase();
  const text = sampleHead(sample)
    .toString("utf8")
    .replace(/^\uFEFF/, "")
    .trimStart()
    .toLowerCase();

  return (
    ct.includes("text/html") ||
    ct.includes("application/json") ||
    text.startsWith("<!doctype html") ||
    text.startsWith("<html") ||
    text.startsWith("<head") ||
    text.startsWith("<body") ||
    text.startsWith("<?xml") ||
    text.startsWith('{"error"') ||
    text.startsWith('{"message"')
  );
}

function looksLikeHlsBody(sample) {
  return sampleHead(sample)
    .toString("utf8")
    .replace(/^\uFEFF/, "")
    .trimStart()
    .startsWith("#EXTM3U");
}

function looksLikeIsoBmff(sample) {
  const head = sampleHead(sample);
  if (head.length < 8) return false;
  const box = head.subarray(4, 8).toString("ascii");
  return new Set(["ftyp", "styp", "moov", "mdat", "free", "skip", "wide", "uuid"])
    .has(box);
}

async function readResponseSample(response, maxBytes = MEDIA_SAMPLE_BYTES) {
  const body = response?.body;
  if (!body) return new Uint8Array();

  if (typeof body.getReader === "function") {
    const reader = body.getReader();
    const chunks = [];
    let total = 0;

    try {
      while (total < maxBytes) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = value instanceof Uint8Array
          ? value
          : new Uint8Array(value || []);
        const take = chunk.subarray(0, maxBytes - total);
        if (take.length) {
          chunks.push(take);
          total += take.length;
        }
        if (take.length < chunk.length) break;
      }
    } finally {
      try { await reader.cancel(); } catch {}
    }

    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }

  // Compatibilidade com respostas simuladas nos testes.
  if (typeof response.arrayBuffer === "function") {
    const data = new Uint8Array(await response.arrayBuffer());
    return data.subarray(0, maxBytes);
  }

  try { await body.cancel?.(); } catch {}
  return new Uint8Array();
}

function assessSuccessfulMedia(response, sample, rawUrl) {
  const contentType = responseHeader(response, "Content-Type").toLowerCase();
  const totalBytes = reportedResponseLength(response);

  if (Number(response.status) === 204 || Number(response.status) === 304) {
    return { verdict: "dead", reason: "empty-media", totalBytes };
  }
  if (totalBytes === 0) {
    return { verdict: "dead", reason: "empty-media", totalBytes };
  }
  if (!sample.length) {
    return { verdict: "dead", reason: "empty-media", totalBytes };
  }
  if (looksLikeHtmlOrJson(contentType, sample)) {
    return { verdict: "dead", reason: "non-media-body", totalBytes };
  }

  // HLS pode vir com extensão/content-type incorreto; o corpo é a evidência
  // mais forte.
  if (looksLikeHlsBody(sample)) {
    return { verdict: "alive", reason: "hls", totalBytes };
  }

  const likelyHls =
    /\.m3u8?(?:$|[?#])/i.test(rawUrl) ||
    contentType.includes("mpegurl");
  if (likelyHls) {
    return { verdict: "dead", reason: "invalid-hls", totalBytes };
  }

  const likelyVod = isLikelyVodUrl(rawUrl);
  if (likelyVod && totalBytes !== null && totalBytes < MIN_VOD_BYTES) {
    return { verdict: "dead", reason: "media-too-small", totalBytes };
  }

  const likelyMp4 =
    /\.(?:mp4|m4v|mov)(?:$|[?#])/i.test(rawUrl) ||
    contentType.includes("video/mp4");
  if (likelyMp4) {
    if (looksLikeIsoBmff(sample)) {
      return { verdict: "alive", reason: "mp4", totalBytes };
    }
    // Não elimina automaticamente um arquivo grande e binário só por uma
    // assinatura incomum; mantém como unknown para evitar falso positivo.
    return { verdict: "unknown", reason: "unrecognized-mp4", totalBytes };
  }

  if (
    contentType.startsWith("video/") ||
    contentType.startsWith("audio/") ||
    contentType.includes("application/octet-stream")
  ) {
    return sample.length >= 1024
      ? { verdict: "alive", reason: "binary-media", totalBytes }
      : { verdict: "unknown", reason: "tiny-unrecognized-body", totalBytes };
  }

  return sample.length >= 1024
    ? { verdict: "unknown", reason: "unrecognized-body", totalBytes }
    : { verdict: "dead", reason: "tiny-unrecognized-body", totalBytes };
}

export function streamPoolKey(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const parts = url.pathname.split("/").filter(Boolean);
    const host = url.host.toLowerCase();
    if (!parts.length) return host;

    const first = (parts[0] || "").toLowerCase();
    if (["live", "movie", "series"].includes(first) && parts.length >= 3) {
      return [host, parts[0], parts[1], parts[2]].join("/");
    }

    // CDN/HLS assets with per-title hashes are deliberately grouped only by
    // host. Account-style IPTV URLs retain user/password path segments above.
    if (/^(?:cdn|hls|ss|stream|streams)$/i.test(first)) return host + "/" + first;
    if (parts.length >= 3 && /\.(?:mp4|mkv|ts|m3u8?|txt)$/i.test(parts.at(-1) || "")) {
      return [host, parts[0], parts[1]].join("/");
    }
    return host + "/" + first;
  } catch {
    return "";
  }
}

function urlHash(value) {
  return createHash("sha1").update(String(value)).digest().readUInt32BE(0);
}

async function mapLimit(values, limit, worker) {
  const out = new Array(values.length);
  let cursor = 0;

  async function run() {
    while (true) {
      const index = cursor++;
      if (index >= values.length) return;
      out[index] = await worker(values[index], index);
    }
  }

  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, values.length || 1)) }, () => run())
  );
  return out;
}

export async function probeVariant(variant, fetchImpl = fetch, timeoutMs = 3500) {
  let url;
  try {
    url = new URL(variant.url);
  } catch {
    return { verdict: "dead", status: 0, reason: "invalid-url" };
  }

  if (KNOWN_DEAD_HOSTS.has(url.hostname.toLowerCase())) {
    return { verdict: "dead", status: 0, reason: "known-dead-host" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("timeout"), timeoutMs);

  try {
    const response = await fetchImpl(url, {
      method: "GET",
      redirect: "follow",
      headers: {
        ...compactHeaders(variant),
        // Lê somente o início do recurso: suficiente para distinguir mídia
        // real de 200 vazio/HTML/arquivo minúsculo sem baixar o VOD inteiro.
        Range: "bytes=0-" + (MEDIA_SAMPLE_BYTES - 1)
      },
      signal: controller.signal
    });

    if (response.ok || response.status === 206) {
      const sample = await readResponseSample(response, MEDIA_SAMPLE_BYTES);
      const assessment = assessSuccessfulMedia(
        response,
        sample,
        response.url || variant.url
      );
      return {
        verdict: assessment.verdict,
        status: response.status,
        reason: assessment.reason,
        bytes: assessment.totalBytes,
        sampled: sample.length
      };
    }

    // Range 0..4095 deveria funcionar para qualquer recurso não vazio.
    // Alguns servidores quebrados devolvem 416; só é morte certa quando
    // Content-Range informa tamanho total zero.
    if (response.status === 416) {
      const totalBytes = reportedResponseLength(response);
      try { await response.body?.cancel(); } catch {}
      return totalBytes === 0
        ? { verdict: "dead", status: 416, reason: "empty-media", bytes: 0 }
        : { verdict: "unknown", status: 416, reason: "range-rejected", bytes: totalBytes };
    }

    try { await response.body?.cancel(); } catch {}

    if (DEFINITIVE_DEAD.has(response.status)) {
      return { verdict: "dead", status: response.status, reason: "http-" + response.status };
    }
    return { verdict: "unknown", status: response.status, reason: "http-" + response.status };
  } catch {
    return { verdict: "unknown", status: 0, reason: "network-error" };
  } finally {
    clearTimeout(timer);
  }
}

function poolSamples(items, sampleCount) {
  const pools = new Map();

  for (const item of items) {
    for (const variant of item.variants || []) {
      if (!variant?.url) continue;
      const key = streamPoolKey(variant.url);
      if (!key) continue;
      let pool = pools.get(key);
      if (!pool) {
        pool = { key, total: 0, samples: [] };
        pools.set(key, pool);
      }
      pool.total += 1;
      if (pool.samples.length < sampleCount) pool.samples.push(variant);
    }
  }

  return [...pools.values()];
}

function removeDeadVariants(items, deadPools, deadUrls = new Set()) {
  const out = [];
  let removedVariants = 0;
  let removedItems = 0;

  for (const item of items) {
    const variants = (item.variants || []).filter((variant) => {
      const pool = streamPoolKey(variant.url);
      const dead = deadUrls.has(variant.url) || (pool && deadPools.has(pool));
      if (dead) removedVariants += 1;
      return !dead;
    });

    if (!variants.length) {
      removedItems += 1;
      continue;
    }

    out.push({ ...item, variants });
  }

  return { items: out, removedVariants, removedItems };
}

/**
 * Sanitização em duas camadas:
 *
 * 1. testa poucos representantes por pool/conta. Um login morto pode eliminar
 *    dezenas de milhares de URLs com apenas 2-3 requisições;
 * 2. testa uma rotação determinística de URLs individuais. Isso encontra 404
 *    específicos sem transformar cada regeneração em centenas de milhares de
 *    requisições.
 *
 * Falhas transitórias (timeout/5xx não definitivo) nunca removem conteúdo.
 */
export async function sanitizeCatalog(
  items,
  {
    fetchImpl = fetch,
    poolSamplesCount = 3,
    poolConcurrency = 48,
    itemProbeBudget = 20000,
    itemConcurrency = 128,
    timeoutMs = 3500,
    rotation = 0,
    persistedDead = {},
    deadTtlMs = 24 * 60 * 60 * 1000,
    now = Date.now()
  } = {}
) {
  const catalogUrls = new Set();
  for (const item of items || []) {
    for (const variant of item.variants || []) {
      if (variant?.url) catalogUrls.add(variant.url);
    }
  }

  // 404/410 individuais encontrados em execuções anteriores permanecem fora
  // por um TTL. Depois disso voltam à fila de teste para permitir recuperação.
  const cachedDead = new Set();
  for (const [url, checkedAt] of Object.entries(persistedDead || {})) {
    if (now - Number(checkedAt || 0) < deadTtlMs) cachedDead.add(url);
  }

  const preCached = removeDeadVariants(items, new Set(), cachedDead);
  const pools = poolSamples(preCached.items, poolSamplesCount);

  const poolReports = await mapLimit(pools, poolConcurrency, async (pool) => {
    const results = [];
    for (const variant of pool.samples) {
      results.push(await probeVariant(variant, fetchImpl, timeoutMs));
      if (results.some((row) => row.verdict === "alive")) break;
    }

    return {
      key: pool.key,
      total: pool.total,
      results,
      dead:
        results.length > 0 &&
        results.every((row) => row.verdict === "dead")
    };
  });

  const deadPools = new Set(poolReports.filter((row) => row.dead).map((row) => row.key));
  const afterPools = removeDeadVariants(preCached.items, deadPools);

  // A janela de teste gira pelo conjunto ordenado por hash. Assim um orçamento
  // fixo cobre o catálogo inteiro ao longo das execuções, sem ficar preso aos
  // primeiros 20 mil itens de cada bucket.
  const unique = new Map();
  for (const item of afterPools.items) {
    for (const variant of item.variants || []) {
      if (!unique.has(variant.url)) unique.set(variant.url, variant);
    }
  }

  const orderedUnique = [...unique.values()].sort(
    (a, b) => urlHash(a.url) - urlHash(b.url)
  );
  const budget = Math.min(
    Math.max(0, Number(itemProbeBudget || 0)),
    orderedUnique.length
  );
  const start = orderedUnique.length
    ? (Math.abs(Number(rotation || 0)) * Math.max(1, budget)) % orderedUnique.length
    : 0;
  const candidates = [];
  for (let offset = 0; offset < budget; offset += 1) {
    candidates.push(orderedUnique[(start + offset) % orderedUnique.length]);
  }

  const itemReports = await mapLimit(candidates, itemConcurrency, async (variant) => ({
    url: variant.url,
    result: await probeVariant(variant, fetchImpl, timeoutMs)
  }));

  const deadUrls = new Set(
    itemReports
      .filter((row) => row.result.verdict === "dead")
      .map((row) => row.url)
  );
  const final = removeDeadVariants(afterPools.items, new Set(), deadUrls);

  const nextDead = {};
  for (const [url, checkedAt] of Object.entries(persistedDead || {})) {
    if (catalogUrls.has(url) && !itemReports.some(
      (row) => row.url === url && row.result.verdict === "alive"
    )) {
      nextDead[url] = Number(checkedAt || now);
    }
  }
  for (const url of deadUrls) nextDead[url] = now;

  // URLs comprovadamente vivas sobem para o topo das variantes do item.
  const aliveUrls = new Set(
    itemReports
      .filter((row) => row.result.verdict === "alive")
      .map((row) => row.url)
  );
  for (const item of final.items) {
    item.variants.sort((a, b) =>
      Number(aliveUrls.has(b.url)) - Number(aliveUrls.has(a.url)) ||
      Number(a.priority || 50) - Number(b.priority || 50)
    );
  }

  return {
    items: final.items,
    report: {
      pools_checked: poolReports.length,
      dead_pools: poolReports.filter((row) => row.dead).map((row) => ({
        key: row.key,
        total: row.total,
        statuses: row.results.map((result) => result.status)
      })),
      item_urls_tested: itemReports.length,
      item_urls_dead: deadUrls.size,
      removed_variants:
        preCached.removedVariants + afterPools.removedVariants + final.removedVariants,
      removed_items:
        preCached.removedItems + afterPools.removedItems + final.removedItems,
      cached_dead_urls: cachedDead.size
    },
    deadCache: nextDead
  };
}
