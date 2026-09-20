// SPDX-License-Identifier: MIT
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import process from "node:process";

import {
  buildCardIndex,
  buildFailoverIndex,
  loadLocalUpstreams,
  mergeCatalog,
  renderCardShards,
  renderCompactM3U,
  renderFailoverShards,
  validateCatalog
} from "../src/build.js";
import { sanitizeCatalog } from "../src/health.js";
import { summarizeTaxonomy } from "../src/taxonomy.js";

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(name + " is required");
  return value;
}

function numberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

async function main() {
  const saimoRoot = required("SAIMO_ROOT");
  const ramysRoot = required("RAMYS_ROOT");

  const loaded = await loadLocalUpstreams({ saimoRoot, ramysRoot });
  const classification = {};
  const merged = mergeCatalog(loaded.items, { report: classification });

  if (merged.length < 1000) {
    throw new Error("catalog unexpectedly small before health checks: " + merged.length);
  }

  // O cache pode incluir falhas definitivas importadas de auditorias locais.
  let persistedDead = {};
  const cachePath = process.env.HEALTH_CACHE_PATH || "";
  if (cachePath) {
    try {
      const parsed = JSON.parse(await readFile(cachePath, "utf8"));
      persistedDead = parsed?.dead && typeof parsed.dead === "object" ? parsed.dead : {};
    } catch {
      persistedDead = {};
    }
  }

  const rotation = Math.floor(Date.now() / (3 * 60 * 60 * 1000));
  const sanitized = await sanitizeCatalog(merged, {
    poolSamplesCount: numberEnv("POOL_SAMPLES", 3),
    poolConcurrency: numberEnv("POOL_CONCURRENCY", 48),
    itemProbeBudget: numberEnv("ITEM_PROBE_BUDGET", 20000),
    itemConcurrency: numberEnv("ITEM_CONCURRENCY", 128),
    timeoutMs: numberEnv("PROBE_TIMEOUT_MS", 3500),
    rotation,
    persistedDead
  });

  const validation = validateCatalog(sanitized.items);
  if (!validation.ok) {
    throw new Error(
      "catalog validation failed:\n" + validation.errors.slice(0, 20).join("\n")
    );
  }

  const failover = buildFailoverIndex(sanitized.items, {
    maxVariants: numberEnv("MAX_RUNTIME_FALLBACKS", 6)
  });
  const cards = buildCardIndex(sanitized.items);
  const fallbackIndexBase = String(
    process.env.FALLBACK_INDEX_BASE ||
      "https://raw.githubusercontent.com/xoykor/Lista/static-fallback/fallback"
  ).trim();
  const cardIndexBase = String(
    process.env.CARD_INDEX_BASE ||
      "https://raw.githubusercontent.com/xoykor/Lista/static-fallback/cards"
  ).trim();

  const rendered = renderCompactM3U(sanitized.items, {
    // GitHub bloqueia blobs acima de 100 MiB. Mantemos folga para não depender
    // de uma alteração pequena nos upstreams para quebrar a publicação.
    maxBytes: 97 * 1024 * 1024,
    failoverIndex: failover,
    fallbackIndexBase,
    fallbackIndexVersion: failover.version,
    fallbackIndexShardLength: 2,
    cardIndexBase,
    cardIndexVersion: cards.version,
    cardIndexShardLength: 2
  });

  if (rendered.included < 1000) {
    throw new Error("rendered catalog unexpectedly small: " + rendered.included);
  }

  await rm("dist", { recursive: true, force: true });
  await mkdir("dist/static/fallback", { recursive: true });
  await mkdir("dist/static/cards", { recursive: true });
  await writeFile("dist/static/list.m3u8", rendered.body, "utf8");

  /*
   * Keep 1-hex shards for backward compatibility with already released
   * desktop clients, and add 2-hex shards for memory-constrained TVs.
   * A visible Tizen page then downloads ~1/16 of the metadata per lookup.
   */
  const cardFiles = renderCardShards(cards, { prefixLengths: [1, 2] });
  for (const [name, body] of cardFiles) {
    await writeFile("dist/static/cards/" + name, body, "utf8");
  }

  const failoverFiles = renderFailoverShards(failover);
  for (const [name, body] of failoverFiles) {
    await writeFile("dist/static/fallback/" + name, body, "utf8");
  }
  await writeFile(
    "dist/static/health-cache.json",
    JSON.stringify({ dead: sanitized.deadCache }, null, 2) + "\n",
    "utf8"
  );

  const status = {
    generated_at: new Date().toISOString(),
    revision: process.env.GITHUB_SHA || null,
    upstream_revisions: {
      saimo: process.env.SAIMO_REVISION || null,
      ramys: process.env.RAMYS_REVISION || null
    },
    inputs: loaded.sourceStats,
    merged_items: merged.length,
    published_items: rendered.included,
    omitted_by_size: rendered.omittedBySize,
    bytes: rendered.bytes,
    hosting: "github-static",
    runtime_worker_dependency: false,
    fallback_index_base: fallbackIndexBase,
    cards: {
      version: cards.version,
      base: cardIndexBase,
      ...cards.report,
      preferred_shard_prefix_length: 2,
      shard_prefix_lengths: [1, 2],
      shards: cardFiles.size
    },
    failover: {
      version: failover.version,
      ...failover.report
    },
    classification,
    health: sanitized.report,
    taxonomy: summarizeTaxonomy(sanitized.items)
  };

  await writeFile(
    "dist/static/status.json",
    JSON.stringify(status, null, 2) + "\n",
    "utf8"
  );

  console.log(JSON.stringify(status, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
