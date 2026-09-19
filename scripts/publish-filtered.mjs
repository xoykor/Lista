// SPDX-License-Identifier: MIT
import { readFile } from "node:fs/promises";
import process from "node:process";

const FILTERED_PATH = "dist/health-scan/filtered.m3u8";
const REPORT_PATH = "dist/health-scan/report.json";
const CHUNK_TARGET_BYTES = 120 * 1024;
const UPLOAD_BATCH_CHUNKS = 64;

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(name + " is required");
  return value.trim();
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

async function main() {
  const workerUrl = required("WORKER_URL").replace(/\/$/, "");
  const uploadSecret = required("CATALOG_UPLOAD_SECRET");
  const auth = { "X-Lista-Catalog-Token": uploadSecret };

  const body = await readFile(FILTERED_PATH, "utf8");
  const report = JSON.parse(await readFile(REPORT_PATH, "utf8"));
  const chunks = chunkPlaylist(body);
  const itemCount = body.split("\n").filter((line) => line.startsWith("#EXTINF")).length;
  const generation =
    new Date().toISOString().replace(/[:.]/g, "-") +
    "-deep-" +
    String(process.env.GITHUB_SHA || "manual").slice(0, 12);

  const metadata = {
    generation,
    chunk_count: chunks.length,
    item_count: itemCount,
    revision: process.env.GITHUB_SHA || null,
    deep_health: {
      alive_resolvers: report.alive_resolvers,
      dead_resolvers: report.dead_resolvers,
      unknown_resolvers: report.unknown_resolvers,
      dead_channel_entries_removed: report.dead_channel_entries_removed,
      restricted_entries_removed: report.restricted_entries_removed
    },
    upstreams: [{
      id: "closed-loop-health",
      ok: true,
      count: itemCount
    }]
  };

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
    channels: itemCount,
    chunks: chunks.length,
    upload_requests: uploadRequests,
    deep_health: metadata.deep_health,
    committed
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
