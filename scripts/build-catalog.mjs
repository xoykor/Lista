// SPDX-License-Identifier: MIT
import { mkdir, rm, writeFile } from "node:fs/promises";
import process from "node:process";

import {
  loadLocalUpstreams,
  mergeCatalog,
  renderCompactM3U,
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
  const merged = mergeCatalog(loaded.items);

  if (merged.length < 1000) {
    throw new Error("catalog unexpectedly small before health checks: " + merged.length);
  }

  const rotation = Math.floor(Date.now() / (3 * 60 * 60 * 1000));
  const sanitized = await sanitizeCatalog(merged, {
    poolSamplesCount: numberEnv("POOL_SAMPLES", 3),
    poolConcurrency: numberEnv("POOL_CONCURRENCY", 48),
    itemProbeBudget: numberEnv("ITEM_PROBE_BUDGET", 20000),
    itemConcurrency: numberEnv("ITEM_CONCURRENCY", 128),
    timeoutMs: numberEnv("PROBE_TIMEOUT_MS", 3500),
    rotation
  });

  const validation = validateCatalog(sanitized.items);
  if (!validation.ok) {
    throw new Error(
      "catalog validation failed:\n" + validation.errors.slice(0, 20).join("\n")
    );
  }

  const rendered = renderCompactM3U(sanitized.items, {
    // GitHub bloqueia blobs acima de 100 MiB. Mantemos folga para não depender
    // de uma alteração pequena nos upstreams para quebrar a publicação.
    maxBytes: 97 * 1024 * 1024
  });

  if (rendered.included < 1000) {
    throw new Error("rendered catalog unexpectedly small: " + rendered.included);
  }

  await rm("dist", { recursive: true, force: true });
  await mkdir("dist/static", { recursive: true });
  await writeFile("dist/static/list.m3u8", rendered.body, "utf8");

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
    cloudflare_requests: 0,
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
