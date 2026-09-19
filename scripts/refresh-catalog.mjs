// SPDX-License-Identifier: MIT
import { mkdir, rm, writeFile } from "node:fs/promises";
import process from "node:process";

import { buildCatalog, renderLiveM3U } from "../src/catalog.js";
import { sourcesFor } from "../src/sources.js";
import { fetchVariant } from "../src/hls.js";
import { pruneDeadStreamPools } from "../src/health.js";

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
  const response = await fetch(url, options);
  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      options.method + " " + url + " -> " + response.status + ": " + text.slice(0, 500)
    );
  }

  return text ? JSON.parse(text) : {};
}

async function probeQuarantinedItem(item) {
  for (const variant of item.variants.slice(0, 8)) {
    if (variant.provider) {
      // Provider-backed channels such as Pluto are resolved dynamically by
      // the Worker and should not remain quarantined based on a stale session.
      return true;
    }

    const result = await fetchVariant({
      u: variant.url,
      r: variant.referer || undefined,
      a: variant.userAgent || undefined
    });

    if (result.ok) return true;
  }

  return false;
}

async function main() {
  const workerUrl = required("WORKER_URL").replace(/\/$/, "");
  const uploadSecret = required("CATALOG_UPLOAD_SECRET");
  const tokenSecret = required("TOKEN_SECRET");
  const auth = { "X-Lista-Catalog-Token": uploadSecret };

  const built = await buildCatalog(sourcesFor("live"));
  if (!built.items.length) throw new Error("catalog build returned no channels");

  const preflight = await pruneDeadStreamPools(built.items, {
    minPoolSize: 1,
    sampleCount: 3,
    concurrency: 24
  });

  const dead = await request(workerUrl + "/_catalog/dead/list", {
    method: "GET",
    headers: auth
  });

  const deadKeys = new Set(
    (dead.channels || []).map((entry) => String(entry.key || ""))
  );

  const kept = [];
  const restored = [];
  const quarantined = [];

  for (const item of preflight.items) {
    if (!deadKeys.has(item.key)) {
      kept.push(item);
      continue;
    }

    if (await probeQuarantinedItem(item)) {
      kept.push(item);
      restored.push(item.name);

      await request(workerUrl + "/_catalog/dead/clear", {
        method: "POST",
        headers: {
          ...auth,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ key: item.key })
      });
    } else {
      quarantined.push(item.name);
    }
  }

  const body = await renderLiveM3U(
    kept,
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
    item_count: kept.length,
    quarantined_count: quarantined.length,
    restored_count: restored.length,
    preflight: preflight.report,
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
    channels: kept.length,
    preflight_removed_items: preflight.report.removed_items,
    preflight_removed_variants: preflight.report.removed_variants,
    preflight_dead_pools: preflight.report.pools_dead,
    quarantined: quarantined.length,
    restored: restored.length,
    chunks: chunks.length,
    committed
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
