// SPDX-License-Identifier: MIT
import { mkdir, rm, writeFile } from "node:fs/promises";
import process from "node:process";

import { buildCatalog, renderLiveM3U, renderStaticDirectM3U } from "../src/catalog.js";
import { sourcesFor } from "../src/sources.js";
import { pruneDeadStreamPools } from "../src/health.js";
import { isRestrictedText } from "../src/restricted.js";
import { deepPruneResolverItems } from "../src/deep_health.js";
import { curateSamsungItems } from "../src/curation.js";

const PLACEHOLDER_ORIGIN = "https://lista.internal.invalid";
const CHUNK_TARGET_BYTES = 120 * 1024;
const UPLOAD_BATCH_CHUNKS = 96;

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(name + " is required");
  return value;
}

function generationName() {
  const now = new Date().toISOString().replace(/[:.]/g, "-");
  const sha = String(process.env.GITHUB_SHA || "manual").slice(0, 12);
  return now + "-" + sha;
}

function chunkPlaylist(body) {
  const chunks = [];
  let current = "";
  let bytes = 0;

  for (const line of String(body).split("\n")) {
    const next = line + "\n";
    const nextBytes = Buffer.byteLength(next);

    if (nextBytes > CHUNK_TARGET_BYTES) {
      throw new Error("single catalog line exceeds chunk size");
    }

    if (current && bytes + nextBytes > CHUNK_TARGET_BYTES) {
      chunks.push(current);
      current = "";
      bytes = 0;
    }

    current += next;
    bytes += nextBytes;
  }

  if (current) chunks.push(current);
  return chunks;
}

async function request(url, options) {
  let lastError = null;

  for (let attempt = 0; attempt < 9; attempt += 1) {
    const response = await fetch(url, options);
    const text = await response.text();

    if (response.ok) {
      return text ? JSON.parse(text) : {};
    }

    lastError = new Error(
      options.method + " " + url + " -> " + response.status + ": " + text.slice(0, 500)
    );

    // Cloudflare's Workers Free daily-limit page is returned as HTTP 429
    // and is not a short retryable 1015. Retrying it only creates noise.
    const planLimit429 =
      response.status === 429 &&
      /temporarily rate limited|reached their plan limits|error\s*1027/i.test(text);

    if (planLimit429) {
      throw new Error(
        "Cloudflare Workers Free daily request limit is active (1027-like 429); " +
        "retry after the daily 00:00 UTC reset"
      );
    }

    if (response.status !== 429 && response.status < 500) {
      throw lastError;
    }

    const retryAfter = Number(response.headers.get("retry-after") || "0");
    const delayMs = retryAfter > 0
      ? Math.min(120000, retryAfter * 1000)
      : Math.min(60000, 1500 * (2 ** attempt));

    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  throw lastError || new Error("request failed");
}

async function main() {
  const workerUrl = required("WORKER_URL").replace(/\/$/, "");
  const uploadSecret = required("CATALOG_UPLOAD_SECRET").trim();
  const tokenSecret = required("TOKEN_SECRET").trim();
  const auth = { "X-Lista-Catalog-Token": uploadSecret };

  const built = await buildCatalog(sourcesFor("live"));
  if (!built.items.length) throw new Error("catalog build returned no channels");

  const safeItems = built.items.filter((item) => !isRestrictedText(item.name, item.group));
  const restrictedRemoved = built.items.length - safeItems.length;

  const preflight = await pruneDeadStreamPools(safeItems, {
    minPoolSize: 1,
    sampleCount: 3,
    concurrency: 24
  });

  const deep = await deepPruneResolverItems(preflight.items, {
    firstTimeoutMs: 2500,
    verifyDeadTimeoutMs: 5000,
    firstConcurrency: 96,
    verifyDeadConcurrency: 32
  });

  const body = await renderLiveM3U(
    deep.items,
    PLACEHOLDER_ORIGIN,
    tokenSecret
  );
  const chunks = chunkPlaylist(body);
  const generation = generationName();

  // Always create the Worker-independent fallback before any Worker upload.
  // If Cloudflare is rate-limited, this artifact is still preserved.
  const staticDirect = renderStaticDirectM3U(deep.items);

  // Curated low-memory catalogue for Samsung/Tizen TVs.
  const samsung = curateSamsungItems(deep.items, { maxItems: 1500 });
  const samsungDirect = renderStaticDirectM3U(samsung.items);

  await rm("dist/catalog", { recursive: true, force: true });
  await rm("dist/static", { recursive: true, force: true });
  await mkdir("dist/catalog", { recursive: true });
  await mkdir("dist/static", { recursive: true });

  await writeFile("dist/static/list.m3u8", staticDirect.body, "utf8");
  await writeFile("dist/static/list-samsung.m3u8", samsungDirect.body, "utf8");
  await writeFile(
    "dist/static/status.json",
    JSON.stringify({
      generation,
      channels: staticDirect.included,
      skipped_dynamic_only: staticDirect.skipped,
      worker_required: false,
      samsung: {
        channels: samsungDirect.included,
        curation: samsung.report
      },
      revision: process.env.GITHUB_SHA || null
    }, null, 2) + "\n",
    "utf8"
  );

  for (let index = 0; index < chunks.length; index += 1) {
    await writeFile(
      "dist/catalog/" + String(index).padStart(4, "0") + ".m3u.part",
      chunks[index],
      "utf8"
    );
  }

  const metadata = {
    generation,
    chunk_count: chunks.length,
    item_count: deep.items.length,
    restricted_removed: restrictedRemoved,
    preflight: preflight.report,
    deep_health: deep.report,
    upstreams: built.status,
    revision: process.env.GITHUB_SHA || null
  };

  await writeFile(
    "dist/catalog/metadata.json",
    JSON.stringify(metadata, null, 2) + "\n",
    "utf8"
  );

  let committed = null;
  let uploadRequests = 0;

  for (let start = 0; start < chunks.length; start += UPLOAD_BATCH_CHUNKS) {
    const batch = chunks.slice(start, start + UPLOAD_BATCH_CHUNKS);
    const final = start + batch.length === chunks.length;

    committed = await request(workerUrl + "/_catalog/upload/batch", {
      method: "POST",
      headers: {
        ...auth,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        generation,
        chunk_count: chunks.length,
        start,
        chunks: batch,
        final,
        item_count: metadata.item_count,
        upstreams: metadata.upstreams,
        revision: metadata.revision
      })
    });

    uploadRequests += 1;
  }

  console.log(JSON.stringify({
    generation,
    channels: deep.items.length,
    restricted_removed: restrictedRemoved,
    preflight_removed_items: preflight.report.removed_items,
    preflight_removed_variants: preflight.report.removed_variants,
    preflight_dead_pools: preflight.report.pools_dead,
    deep_checked_resolvers: deep.report.resolver_items_checked,
    deep_alive_resolvers: deep.report.alive_resolvers,
    deep_unknown_resolvers: deep.report.unknown_resolvers,
    deep_confirmed_dead_resolvers: deep.report.confirmed_dead_resolvers,
    chunks: chunks.length,
    static_channels: staticDirect.included,
    static_skipped_dynamic_only: staticDirect.skipped,
    samsung_channels: samsungDirect.included,
    samsung_curation: samsung.report,
    upload_requests: uploadRequests,
    committed
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
