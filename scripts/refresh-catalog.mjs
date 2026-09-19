// SPDX-License-Identifier: MIT
import { mkdir, rm, writeFile } from "node:fs/promises";
import process from "node:process";

import { buildCatalog, renderLiveM3U } from "../src/catalog.js";
import { sourcesFor } from "../src/sources.js";

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

async function main() {
  const workerUrl = required("WORKER_URL").replace(/\/$/, "");
  const uploadSecret = required("CATALOG_UPLOAD_SECRET");
  const tokenSecret = required("TOKEN_SECRET");

  const built = await buildCatalog(sourcesFor("live"));
  if (!built.items.length) throw new Error("catalog build returned no channels");

  const body = await renderLiveM3U(
    built.items,
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
    item_count: built.items.length,
    upstreams: built.status,
    revision: process.env.GITHUB_SHA || null
  };

  await writeFile(
    "dist/catalog/metadata.json",
    JSON.stringify(metadata, null, 2) + "\n",
    "utf8"
  );

  const auth = { "X-Lista-Catalog-Token": uploadSecret };

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
    channels: built.items.length,
    chunks: chunks.length,
    committed
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
