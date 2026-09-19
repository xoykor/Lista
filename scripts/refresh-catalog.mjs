// SPDX-License-Identifier: MIT
import { mkdir, rm, writeFile } from "node:fs/promises";
import process from "node:process";

import { buildCatalog, renderLiveM3U } from "../src/catalog.js";
import { sourcesFor } from "../src/sources.js";
import { pruneDeadStreamPools } from "../src/health.js";
import { isRestrictedText } from "../src/restricted.js";
import { deepPruneResolverItems } from "../src/deep_health.js";

const PLACEHOLDER_ORIGIN = "https://lista.internal.invalid";
const CHUNK_TARGET_BYTES = 96 * 1024;

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

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const response = await fetch(url, options);
    const text = await response.text();

    if (response.ok) {
      return text ? JSON.parse(text) : {};
    }

    lastError = new Error(
      options.method + " " + url + " -> " + response.status + ": " + text.slice(0, 500)
    );

    if (response.status !== 429 && response.status < 500) {
      throw lastError;
    }

    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(30000, 1000 * (2 ** attempt)))
    );
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
    firstTimeoutMs: 5000,
    retryTimeoutMs: 12000,
    verifyDeadTimeoutMs: 12000,
    firstConcurrency: 24,
    retryConcurrency: 12,
    verifyDeadConcurrency: 8
  });

  const body = await renderLiveM3U(
    deep.items,
    PLACEHOLDER_ORIGIN,
    tokenSecret
  );
  const chunks = chunkPlaylist(body);
  const generation = generationName();

  await rm("dist/catalog", { recursive: true, force: true });
  await mkdir("dist/catalog", { recursive: true });

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

  await request(workerUrl + "/_catalog/upload/start", {
    method: "POST",
    headers: {
      ...auth,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(metadata)
  });

  for (let index = 0; index < chunks.length; index += 1) {
    await request(
      workerUrl +
        "/_catalog/upload/chunk/" +
        encodeURIComponent(generation) +
        "/" +
        index,
      {
        method: "PUT",
        headers: {
          ...auth,
          "Content-Type": "text/plain; charset=utf-8"
        },
        body: chunks[index]
      }
    );
  }

  const committed = await request(workerUrl + "/_catalog/upload/commit", {
    method: "POST",
    headers: {
      ...auth,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ generation })
  });

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
    committed
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
