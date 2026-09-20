// SPDX-License-Identifier: MIT
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { normalizeName } from "./normalize.js";
import { isRestrictedText } from "./restricted.js";
import {
  canonicalGroupTitle,
  canonicalizeItem,
  orderCatalogByTaxonomy
} from "./taxonomy.js";

function clean(value) {
  return String(value || "").trim();
}

function attr(line, name) {
  const match = String(line).match(new RegExp(name + '="([^"]*)"', "i"));
  return match ? match[1] : "";
}

function validHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function variantKey(variant) {
  return [
    clean(variant.url),
    clean(variant.referer),
    clean(variant.userAgent),
    clean(variant.language)
  ].join("\u0000");
}

function itemKey(item) {
  return (item.section || item.sectionHint || "") + "\u0000" + normalizeName(item.name);
}

function stripYear(title) {
  return clean(title).replace(/\s*\((?:19|20)\d{2}\)\s*$/, "").trim();
}

export function seriesBaseName(value) {
  return stripYear(String(value || ""))
    .replace(/\s*[-|:]?\s*(?:S|T)\s*\d{1,3}\s*[-._ ]*E\s*\d{1,4}.*$/i, "")
    .replace(/\s*[-|:]?\s*\d{1,3}\s*[xX]\s*\d{1,4}.*$/, "")
    .replace(/\s*[-|:]?\s*(?:EP|EPISODIO|EPISÓDIO)\s*\d+.*$/i, "")
    .replace(/\s*\[(?:DUB|LEG|DUBLADO|LEGENDADO)\]\s*$/i, "")
    .trim();
}

export function parseM3UText(text, source = {}) {
  const out = [];
  let pending = null;
  let referer = "";
  let userAgent = "";

  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith("#EXTINF:")) {
      const comma = line.lastIndexOf(",");
      const title = comma >= 0 ? line.slice(comma + 1).trim() : "";
      pending = {
        name: attr(line, "tvg-name") || attr(line, "tvg-id") || title,
        logo: attr(line, "tvg-logo"),
        group: attr(line, "group-title")
      };
      referer = "";
      userAgent = "";
      continue;
    }

    if (line.startsWith("#EXTVLCOPT:http-referrer=")) {
      referer = line.slice("#EXTVLCOPT:http-referrer=".length).trim();
      continue;
    }

    if (line.startsWith("#EXTVLCOPT:http-user-agent=")) {
      userAgent = line.slice("#EXTVLCOPT:http-user-agent=".length).trim();
      continue;
    }

    if (line.startsWith("#")) continue;

    if (pending && validHttpUrl(line)) {
      const item = {
        name: pending.name,
        logo: pending.logo,
        group: pending.group,
        kindHint: source.kind || "",
        variants: [{
          url: line,
          referer: referer || null,
          userAgent: userAgent || null,
          origin: source.id || "",
          priority: Number(source.priority || 50)
        }]
      };
      canonicalizeItem(item);
      out.push(item);
    }

    pending = null;
    referer = "";
    userAgent = "";
  }

  return out;
}

export function parseSaimoCatalogText(text, source = {}) {
  const out = [];
  let item = null;
  let variant = null;

  function flush() {
    if (item?.name && item.variants.length) {
      item.kindHint = "live";
      canonicalizeItem(item);
      out.push(item);
    }
    item = null;
    variant = null;
  }

  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;

    if (line.startsWith("canal:")) {
      flush();
      item = {
        name: line.slice(6).trim(),
        logo: "",
        group: "",
        variants: []
      };
      continue;
    }
    if (!item) continue;

    if (line.startsWith("logo:")) {
      item.logo = line.slice(5).trim();
    } else if (line.startsWith("categoria:")) {
      item.group = line.slice(10).trim();
    } else if (line.startsWith("fonte:")) {
      const url = line.slice(6).trim();
      variant = validHttpUrl(url) ? {
        url,
        referer: null,
        userAgent: null,
        origin: source.id || "saimo-catalogo",
        priority: Number(source.priority || 5)
      } : null;
      if (variant) item.variants.push(variant);
    } else if (variant && line.startsWith("referer:")) {
      variant.referer = line.slice(8).trim() || null;
    } else if (variant && line.startsWith("agente:")) {
      variant.userAgent = line.slice(7).trim() || null;
    } else if (variant && line.startsWith("chave:")) {
      // DRM/ClearKey não entra na lista estática.
      const index = item.variants.indexOf(variant);
      if (index >= 0) item.variants.splice(index, 1);
      variant = null;
    }
  }

  flush();
  return out;
}

export function parseSaimoBases(text) {
  const bases = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    const match = raw.match(/^base:\s*(\d+)\s+(https?:\/\/\S+)\s*$/i);
    if (!match) continue;
    bases[Number(match[1])] = match[2];
  }
  return bases;
}

export function resolveSaimoSource(value, bases) {
  const source = clean(value);
  if (!source) return "";
  if (validHttpUrl(source)) return source;

  const colon = source.indexOf(":");
  if (colon <= 0) return "";
  const index = Number(source.slice(0, colon));
  if (!Number.isInteger(index) || !bases[index]) return "";

  const rest = source.slice(colon + 1);
  if (!rest) return "";
  return bases[index] + rest + (rest.includes(".") ? "" : ".mp4");
}

function parseVersionFields(fields, bases, meta = {}) {
  const variants = [];

  for (const field of fields) {
    const equal = field.indexOf("=");
    if (equal <= 0) continue;
    const language = clean(field.slice(0, equal)).toLowerCase();
    if (!["dub", "leg"].includes(language)) continue;

    for (const raw of field.slice(equal + 1).split(",")) {
      const url = resolveSaimoSource(raw, bases);
      if (!validHttpUrl(url)) continue;
      variants.push({
        url,
        referer: null,
        userAgent: null,
        language,
        origin: meta.origin || "saimo-vod",
        priority: Number(meta.priority ?? (language === "dub" ? 3 : 4))
      });
    }
  }

  return variants;
}

function parseSaimoMovieLines(text, bases, meta = {}) {
  const out = [];

  for (const raw of String(text || "").split(/\r?\n/)) {
    if (!raw.trim() || raw.startsWith("#")) continue;
    const fields = raw.split("\t");
    const name = clean(fields[0]);
    if (!name) continue;

    const variants = parseVersionFields(fields.slice(1), bases, meta);
    if (!variants.length) continue;

    out.push({
      name,
      logo: "",
      group: "Filmes",
      sectionHint: "Filmes",
      categoryHint: meta.category || "",
      variants
    });
  }

  return out;
}

function episodeName(series, season, episode) {
  const s = String(Math.max(0, Number(season) || 0)).padStart(2, "0");
  const e = String(Math.max(0, Number(episode) || 0)).padStart(2, "0");
  return series + " S" + s + "E" + e;
}

function parseSaimoSeriesBlocks(text, bases, meta = {}) {
  const map = new Map();
  let series = "";

  for (const raw of String(text || "").split(/\r?\n/)) {
    if (!raw.trim()) continue;

    if (raw.startsWith("@")) {
      series = clean(raw.slice(1).split("\t")[0]);
      continue;
    }
    if (!series) continue;

    const fields = raw.split("\t");
    if (fields.length < 4) continue;

    const season = Number(fields[0]);
    const episode = Number(fields[1]);
    const language = clean(fields[2]).toLowerCase();
    if (!Number.isFinite(season) || !Number.isFinite(episode)) continue;
    if (!["dub", "leg"].includes(language)) continue;

    const name = episodeName(series, season, episode);
    const key = normalizeName(name);
    let item = map.get(key);
    if (!item) {
      item = {
        name,
        seriesTitle: series,
        logo: "",
        group: meta.group || "Séries",
        sectionHint: "Séries",
        categoryHint: meta.category || "",
        variants: []
      };
      map.set(key, item);
    }

    for (const source of fields[3].split(",")) {
      const url = resolveSaimoSource(source, bases);
      if (!validHttpUrl(url)) continue;
      item.variants.push({
        url,
        referer: null,
        userAgent: null,
        language,
        origin: meta.origin || "saimo-vod",
        priority: Number(meta.priority ?? (language === "dub" ? 3 : 4))
      });
    }
  }

  return [...map.values()].filter((item) => item.variants.length);
}

async function filesMatching(directory, regex) {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && regex.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

async function readUtf8(file) {
  return readFile(file, "utf8");
}

function appendAll(target, rows) {
  for (const row of rows || []) target.push(row);
}

export async function loadSaimoVod(root) {
  const vod = path.join(root, "vod");
  const bases = parseSaimoBases(await readUtf8(path.join(vod, "indice.txt")));
  const items = [];

  const movieFiles = await filesMatching(vod, /^filmes-(?:#|%23|[A-Z])\.txt$/i);
  for (const file of movieFiles) {
    appendAll(items, parseSaimoMovieLines(
      await readUtf8(path.join(vod, file)),
      bases,
      { origin: "saimo-vod", priority: 8 }
    ));
  }

  const seriesFiles = await filesMatching(vod, /^series-(?:#|%23|[A-Z])-\d+\.txt$/i);
  for (const file of seriesFiles) {
    appendAll(items, parseSaimoSeriesBlocks(
      await readUtf8(path.join(vod, file)),
      bases,
      { origin: "saimo-vod", priority: 8 }
    ));
  }

  const redeflix = path.join(vod, "redeflix");
  const extraMovies = path.join(redeflix, "links-filmes.txt");
  try {
    appendAll(items, parseSaimoMovieLines(
      await readUtf8(extraMovies),
      bases,
      { origin: "saimo-redeflix", priority: 1 }
    ));
  } catch {
    // O arquivo é opcional.
  }

  for (const [file, category] of [
    ["links-series.txt", ""],
    ["links-animes.txt", "Anime"],
    ["links-doramas.txt", "Doramas"]
  ]) {
    try {
      appendAll(items, parseSaimoSeriesBlocks(
        await readUtf8(path.join(redeflix, file)),
        bases,
        { origin: "saimo-redeflix", priority: 1, category }
      ));
    } catch {
      // Coleções opcionais não impedem a regeneração.
    }
  }

  return items;
}

export async function loadLocalUpstreams({ saimoRoot, ramysRoot }) {
  const items = [];
  const sourceStats = {};

  const push = (id, rows) => {
    sourceStats[id] = rows.length;
    appendAll(items, rows);
  };

  push("saimo-catalogo", parseSaimoCatalogText(
    await readUtf8(path.join(saimoRoot, "catalogo.txt")),
    { id: "saimo-catalogo", priority: 1 }
  ));

  try {
    push("saimo-canais", parseM3UText(
      await readUtf8(path.join(saimoRoot, "canais.txt")),
      { id: "saimo-canais", kind: "live", priority: 2 }
    ));
  } catch {
    sourceStats["saimo-canais"] = 0;
  }

  const ramysFiles = [
    ["ramys-br01", "CanaisBR01.m3u8", "live", 10],
    ["ramys-br02", "CanaisBR02.m3u8", "live", 11],
    ["ramys-br03", "CanaisBR03.m3u8", "live", 12],
    ["ramys-br04", "CanaisBR04.m3u8", "live", 13],
    ["ramys-vod", "Filmes-Series.m3u8", "vod", 10]
  ];

  for (const [id, file, kind, priority] of ramysFiles) {
    try {
      push(id, parseM3UText(
        await readUtf8(path.join(ramysRoot, file)),
        { id, kind, priority }
      ));
    } catch {
      sourceStats[id] = 0;
    }
  }

  const vod = await loadSaimoVod(saimoRoot);
  push("saimo-vod", vod);

  return { items, sourceStats };
}

export function buildEnrichmentIndex(items) {
  const movies = new Map();
  const series = new Map();

  for (const item of items || []) {
    if (item.section === "Filmes" && item.group && item.group !== "Outros") {
      movies.set(normalizeName(stripYear(item.name)), item.group);
    }

    if (item.section === "Séries" && item.group && item.group !== "Outros") {
      const base = normalizeName(seriesBaseName(item.seriesTitle || item.name));
      if (base) series.set(base, item.group);
    }
  }

  return { movies, series };
}

export function applyEnrichment(items, index) {
  for (const item of items || []) {
    if (item.section === "Filmes" && item.group === "Outros") {
      const category = index.movies.get(normalizeName(stripYear(item.name)));
      if (category) item.group = category;
    } else if (item.section === "Séries" && item.group === "Outros") {
      const base = normalizeName(seriesBaseName(item.seriesTitle || item.name));
      const category = index.series.get(base);
      if (category) item.group = category;
    }
  }
  return items;
}

function mergeVariants(target, incoming) {
  const known = new Set(target.variants.map(variantKey));
  for (const variant of incoming.variants || []) {
    const key = variantKey(variant);
    if (!known.has(key)) {
      target.variants.push(variant);
      known.add(key);
    }
  }
}

export function mergeCatalog(items) {
  // Primeiro classifica tudo para que TV, Filmes e Séries com o mesmo nome
  // nunca sejam fundidos acidentalmente.
  for (const item of items || []) canonicalizeItem(item);

  // Ramys é útil também como fonte de metadados. Aplique seus group-title
  // conhecidos aos itens do Saimo quando o título coincidir exatamente.
  const enrichment = buildEnrichmentIndex(items);
  applyEnrichment(items, enrichment);

  const map = new Map();

  for (const item of items || []) {
    if (!item?.name || !item.variants?.length) continue;
    if (isRestrictedText(item.name, item.group)) continue;

    const key = itemKey(item);
    const current = map.get(key);
    if (!current) {
      map.set(key, {
        ...item,
        variants: [...item.variants]
      });
      continue;
    }

    if (!current.logo && item.logo) current.logo = item.logo;
    if (current.group === "Outros" && item.group !== "Outros") current.group = item.group;
    mergeVariants(current, item);
  }

  for (const item of map.values()) {
    item.variants.sort((a, b) => {
      const langA = a.language === "dub" ? 0 : a.language === "leg" ? 1 : 2;
      const langB = b.language === "dub" ? 0 : b.language === "leg" ? 1 : 2;
      return langA - langB || Number(a.priority || 50) - Number(b.priority || 50);
    });
  }

  return orderCatalogByTaxonomy([...map.values()]);
}

function escapeM3U(value) {
  return String(value || "").replace(/"/g, "'").replace(/[\r\n]+/g, " ");
}

export function chooseVariant(item) {
  return (item.variants || []).find((variant) => validHttpUrl(variant.url)) || null;
}

export function renderCompactM3U(items, { maxBytes = 95 * 1024 * 1024 } = {}) {
  const lines = ["#EXTM3U"];
  let bytes = Buffer.byteLength(lines[0] + "\n");
  let included = 0;
  let omittedBySize = 0;

  for (const item of items || []) {
    const variant = chooseVariant(item);
    if (!variant) continue;

    // Deliberadamente sem tvg-name/logo duplicados: a lista precisa caber no
    // limite de blob do GitHub e o Blazzing já usa o título após a vírgula.
    const extinf =
      '#EXTINF:-1 group-title="' + escapeM3U(canonicalGroupTitle(item)) + '",' +
      escapeM3U(item.name);

    const extra = [];
    if (variant.referer) extra.push("#EXTVLCOPT:http-referrer=" + escapeM3U(variant.referer));
    if (variant.userAgent) extra.push("#EXTVLCOPT:http-user-agent=" + escapeM3U(variant.userAgent));

    const block = [extinf, ...extra, variant.url].join("\n") + "\n";
    const blockBytes = Buffer.byteLength(block);

    if (bytes + blockBytes > maxBytes) {
      omittedBySize += 1;
      continue;
    }

    lines.push(block.slice(0, -1));
    bytes += blockBytes;
    included += 1;
  }

  return {
    body: lines.join("\n") + "\n",
    included,
    omittedBySize,
    bytes
  };
}

export function validateCatalog(items) {
  const errors = [];
  const seen = new Set();

  for (const item of items || []) {
    if (!item.name) errors.push("item without name");
    if (!["TV", "Filmes", "Séries"].includes(item.section)) {
      errors.push("invalid section: " + item.section);
    }
    if (!item.variants?.some((variant) => validHttpUrl(variant.url))) {
      errors.push("item without usable URL: " + item.name);
    }

    const key = itemKey(item);
    if (seen.has(key)) errors.push("duplicate canonical item: " + item.name);
    seen.add(key);

    if (errors.length >= 100) break;
  }

  return { ok: errors.length === 0, errors, items: items?.length || 0 };
}
