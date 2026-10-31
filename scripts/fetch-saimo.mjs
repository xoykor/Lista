// SPDX-License-Identifier: MIT
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const CHANNEL_BASES = [
  "https://canais-saimo.pages.dev",
  "https://saimo-canais.pages.dev",
  "https://raw.githubusercontent.com/SaimoTV/SaimoPlayer/main",
  "https://raw.githubusercontent.com/YHWH-P/SaimoPlayer/main"
];

const VOD_BASES = [
  "https://filmes-saimo.pages.dev",
  "https://saimo-filmes.pages.dev",
  "https://raw.githubusercontent.com/YHWH-P/SaimoPlayer/main/vod"
];

const REDEFLIX_FILES = [
  "ids-animes.txt",
  "ids-doramas.txt",
  "series-tmdb.json",
  "catalogo-animes.txt",
  "catalogo-doramas.txt",
  "links-filmes.txt",
  "links-series.txt",
  "links-animes.txt",
  "links-doramas.txt"
];

async function fetchFromMirrors(bases, relativePath, { required = false, timeoutMs = 20000 } = {}) {
  const encodedPath = relativePath
    .split("/")
    .map((segment) => segment.replace(/#/g, "%23"))
    .join("/");

  let lastError = null;
  for (const base of bases) {
    const url = base.replace(/\/$/, "") + "/" + encodedPath;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await fetch(url, {
          headers: {
            "User-Agent": "Lista-Auto-Healing/2.0",
            "Accept": "*/*"
          },
          signal: AbortSignal.timeout(timeoutMs)
        });
        if (response.ok) {
          const text = await response.text();
          if (text && text.trim().length > 0 && !text.trimStart().toLowerCase().startsWith("<!doctype html")) {
            return text;
          }
        }
        if (response.status === 404) break;
        lastError = new Error("HTTP " + response.status + " from " + url);
      } catch (error) {
        lastError = error;
      }
    }
  }

  if (required) {
    throw lastError || new Error("Failed to fetch required Saimo file: " + relativePath);
  }
  return null;
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

export function parseIndiceDrawers(indiceText) {
  const letters = [];
  for (const raw of String(indiceText || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#\t") === false && line.startsWith("#")) continue;
    if (/^base:\s*\d+/i.test(line)) continue;
    const fields = line.split("\t");
    const letter = (fields[0] || "").trim();
    if (letter && (letter === "#" || /^[A-Z]$/i.test(letter))) {
      letters.push({
        letter: letter.toUpperCase(),
        movies: Number(fields[1]) || 0,
        series: Number(fields[2]) || 0
      });
    }
  }
  if (!letters.length) {
    for (const ch of "#ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
      letters.push({ letter: ch, movies: 1, series: 1 });
    }
  }
  return letters;
}

export function parseSeriesParts(seriesIndexText) {
  const parts = new Set();
  for (const raw of String(seriesIndexText || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const fields = line.split("\t");
    if (fields.length >= 3 && fields[2].trim() !== "") {
      const part = Number(fields[2].trim());
      if (Number.isInteger(part) && part >= 0) parts.add(part);
    }
  }
  if (!parts.size) parts.add(0);
  return [...parts].sort((a, b) => a - b);
}

export async function computeSaimoRevision() {
  const hash = createHash("sha256");
  const probes = await Promise.all([
    fetchFromMirrors(CHANNEL_BASES, "catalogo.txt", { required: true }),
    fetchFromMirrors(CHANNEL_BASES, "canais.txt", { required: false }),
    fetchFromMirrors(VOD_BASES, "indice.txt", { required: true }),
    fetchFromMirrors(VOD_BASES, "redeflix/links-series.txt", { required: false }),
    fetchFromMirrors(VOD_BASES, "series-A-0.txt", { required: false })
  ]);

  for (const content of probes) {
    hash.update(String(content || ""));
    hash.update("\u0000");
  }
  return hash.digest("hex").slice(0, 40);
}

export async function downloadSaimoTree(targetRoot, { concurrency = 16 } = {}) {
  const vodRoot = path.join(targetRoot, "vod");
  const redeflixRoot = path.join(vodRoot, "redeflix");
  await mkdir(redeflixRoot, { recursive: true });

  const [catalogo, canais, indice, generos] = await Promise.all([
    fetchFromMirrors(CHANNEL_BASES, "catalogo.txt", { required: true }),
    fetchFromMirrors(CHANNEL_BASES, "canais.txt", { required: false }),
    fetchFromMirrors(VOD_BASES, "indice.txt", { required: true }),
    fetchFromMirrors(VOD_BASES, "generos.txt", { required: false })
  ]);

  await writeFile(path.join(targetRoot, "catalogo.txt"), catalogo, "utf8");
  if (canais) await writeFile(path.join(targetRoot, "canais.txt"), canais, "utf8");
  await writeFile(path.join(vodRoot, "indice.txt"), indice, "utf8");
  if (generos) await writeFile(path.join(vodRoot, "generos.txt"), generos, "utf8");

  const drawers = parseIndiceDrawers(indice);

  await mapLimit(drawers, concurrency, async ({ letter, movies }) => {
    if (movies <= 0) return;
    const fileName = `filmes-${letter}.txt`;
    const content = await fetchFromMirrors(VOD_BASES, fileName, { required: false });
    if (content) {
      await writeFile(path.join(vodRoot, fileName), content, "utf8");
    }
  });

  const seriesShardTasks = [];
  await mapLimit(drawers, concurrency, async ({ letter, series }) => {
    if (series <= 0) return;
    const indexName = `series-${letter}.txt`;
    const indexContent = await fetchFromMirrors(VOD_BASES, indexName, { required: false });
    const parts = indexContent ? parseSeriesParts(indexContent) : [0];
    for (const part of parts) {
      seriesShardTasks.push({ letter, part });
    }
  });

  await mapLimit(seriesShardTasks, concurrency, async ({ letter, part }) => {
    const fileName = `series-${letter}-${part}.txt`;
    const content = await fetchFromMirrors(VOD_BASES, fileName, { required: false });
    if (content) {
      await writeFile(path.join(vodRoot, fileName), content, "utf8");
    }
  });

  await mapLimit(REDEFLIX_FILES, concurrency, async (fileName) => {
    const content = await fetchFromMirrors(VOD_BASES, `redeflix/${fileName}`, { required: false });
    if (content) {
      await writeFile(path.join(redeflixRoot, fileName), content, "utf8");
    }
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--revision")) {
    const rev = await computeSaimoRevision();
    process.stdout.write(rev + "\n");
    return;
  }

  const target = args[0] || process.env.SAIMO_ROOT || "/tmp/SaimoPlayer";
  await downloadSaimoTree(target);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
