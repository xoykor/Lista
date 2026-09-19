// SPDX-License-Identifier: MIT
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import process from "node:process";

const DEFAULT_URL = "https://l.vsxk.workers.dev/list.m3u8";
const DEFAULT_CONCURRENCY = 48;
const DEFAULT_TIMEOUT_MS = 7000;
const OUT_DIR = "dist/health-scan";
const CHECKPOINT_PATH = OUT_DIR + "/checkpoint.jsonl";
const FILTERED_PATH = OUT_DIR + "/filtered.m3u8";
const REPORT_PATH = OUT_DIR + "/report.json";
const DEAD_PATH = OUT_DIR + "/dead-channels.json";

function parseArgs(argv) {
  const options = {
    url: DEFAULT_URL,
    concurrency: DEFAULT_CONCURRENCY,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    rescan: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--url" && argv[i + 1]) {
      options.url = argv[++i];
    } else if (arg === "--concurrency" && argv[i + 1]) {
      options.concurrency = Number(argv[++i]);
    } else if (arg === "--timeout" && argv[i + 1]) {
      options.timeoutMs = Number(argv[++i]);
    } else if (arg === "--rescan") {
      options.rescan = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log([
        "Uso:",
        "  npm run scan:502 -- [opções]",
        "",
        "Opções:",
        "  --url URL             Playlist publicada (padrão: " + DEFAULT_URL + ")",
        "  --concurrency N       Testes simultâneos (padrão: " + DEFAULT_CONCURRENCY + ")",
        "  --timeout MS          Timeout por canal (padrão: " + DEFAULT_TIMEOUT_MS + " ms)",
        "  --rescan              Ignora checkpoint e testa tudo novamente",
        "",
        "Saída:",
        "  " + FILTERED_PATH,
        "  " + REPORT_PATH,
        "  " + DEAD_PATH,
        "  " + CHECKPOINT_PATH
      ].join("\n"));
      process.exit(0);
    }
  }

  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 256) {
    throw new Error("--concurrency deve estar entre 1 e 256");
  }

  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1000 || options.timeoutMs > 60000) {
    throw new Error("--timeout deve estar entre 1000 e 60000 ms");
  }

  return options;
}

function restrictedEntry(extinf) {
  const text = String(extinf || "").normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

  return /(?:\badult(?:o|os|a|as)?\b|\bxxx\b|\+18\b|\b18\+|onlyfans|only\/priva|porn|porno|erotic|erotico|\bsex\b|sexy|hustler|playboy)/i.test(text);
}

function parseExtinfMetadata(line) {
  const comma = line.indexOf(",");
  const name = comma >= 0 ? line.slice(comma + 1).trim() : "";

  const groupMatch = line.match(/group-title="([^"]*)"/i);
  const group = groupMatch ? groupMatch[1] : "";

  return { name, group };
}

function parseM3U(text) {
  const lines = String(text).replace(/\r\n/g, "\n").split("\n");
  const header = [];
  const entries = [];

  let i = 0;
  while (i < lines.length && !lines[i].startsWith("#EXTINF")) {
    if (lines[i]) header.push(lines[i]);
    i += 1;
  }

  while (i < lines.length) {
    if (!lines[i].startsWith("#EXTINF")) {
      i += 1;
      continue;
    }

    const block = [lines[i]];
    const extinf = lines[i];
    i += 1;

    let url = "";
    while (i < lines.length) {
      const line = lines[i];
      block.push(line);
      i += 1;

      if (line && !line.startsWith("#")) {
        url = line.trim();
        break;
      }

      if (line.startsWith("#EXTINF")) {
        // Malformed entry. Back up one line so it can be parsed normally.
        i -= 1;
        block.pop();
        break;
      }
    }

    if (!url) continue;

    const meta = parseExtinfMetadata(extinf);
    entries.push({
      extinf,
      block,
      url,
      name: meta.name,
      group: meta.group,
      restricted: restrictedEntry(extinf)
    });
  }

  return { header, entries };
}

function isResolverUrl(rawUrl, playlistOrigin) {
  try {
    const url = new URL(rawUrl);
    return url.origin === playlistOrigin &&
      /^\/channel\/[A-Za-z0-9_.-]+$/.test(url.pathname);
  } catch {
    return false;
  }
}

async function loadCheckpoint() {
  try {
    const raw = await readFile(CHECKPOINT_PATH, "utf8");
    const map = new Map();

    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const value = JSON.parse(line);
        if (value?.url && value?.verdict) {
          map.set(value.url, value);
        }
      } catch {
        // Ignore a partially written trailing line after interruption.
      }
    }

    return map;
  } catch {
    return new Map();
  }
}

async function probe(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("timeout"), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "HEAD",
      redirect: "manual",
      cache: "no-store",
      signal: controller.signal,
      headers: {
        "Accept": "*/*",
        "User-Agent": "Lista-Local-502-Scanner/1.0"
      }
    });

    const status = response.status;

    if (status >= 200 && status < 400) {
      return { verdict: "alive", status };
    }

    if (status === 502) {
      return { verdict: "dead", status };
    }

    if ([400, 401, 403, 404, 410, 451].includes(status)) {
      return { verdict: "dead", status };
    }

    return { verdict: "unknown", status };
  } catch (error) {
    const message = String(error?.message || error || "request failed");
    return {
      verdict: "unknown",
      status: 0,
      error: message.slice(0, 200)
    };
  } finally {
    clearTimeout(timer);
  }
}

async function mapLimit(values, limit, worker) {
  const results = new Array(values.length);
  let cursor = 0;

  async function run() {
    while (true) {
      const index = cursor++;
      if (index >= values.length) return;
      results[index] = await worker(values[index], index);
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.max(1, Math.min(limit, values.length || 1)) },
      () => run()
    )
  );

  return results;
}

function progress(done, total, alive, dead, unknown) {
  const percent = total ? ((done / total) * 100).toFixed(1) : "100.0";
  process.stdout.write(
    "\r" +
    "Testados " + done + "/" + total +
    " (" + percent + "%)" +
    " | OK " + alive +
    " | mortos " + dead +
    " | incertos " + unknown +
    "      "
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await mkdir(OUT_DIR, { recursive: true });

  console.log("Baixando playlist:", options.url);
  const response = await fetch(options.url, {
    headers: { "User-Agent": "Lista-Local-502-Scanner/1.0" }
  });

  if (!response.ok) {
    throw new Error("playlist retornou HTTP " + response.status);
  }

  const parsed = parseM3U(await response.text());
  const playlistOrigin = new URL(options.url).origin;
  const resolverEntries = parsed.entries.filter(
    (entry) => !entry.restricted && isResolverUrl(entry.url, playlistOrigin)
  );
  const restrictedCount = parsed.entries.filter((entry) => entry.restricted).length;

  console.log("Entradas totais:", parsed.entries.length);
  console.log("Resolvers /channel a testar:", resolverEntries.length);
  console.log("Entradas restritas descartadas antes do teste:", restrictedCount);

  if (options.rescan) {
    await writeFile(CHECKPOINT_PATH, "", "utf8");
  }

  const checkpoint = options.rescan ? new Map() : await loadCheckpoint();
  const urls = [...new Set(resolverEntries.map((entry) => entry.url))];
  const urlSet = new Set(urls);
  const pending = urls.filter((url) => !checkpoint.has(url));

  console.log("Já presentes no checkpoint:", urls.length - pending.length);
  console.log("Pendentes:", pending.length);

  const currentCheckpointRows = [...checkpoint.values()].filter((row) => urlSet.has(row.url));
  let done = urls.length - pending.length;
  let alive = currentCheckpointRows.filter((x) => x.verdict === "alive").length;
  let dead = currentCheckpointRows.filter((x) => x.verdict === "dead").length;
  let unknown = currentCheckpointRows.filter((x) => x.verdict === "unknown").length;
  let checkpointWrite = Promise.resolve();

  progress(done, urls.length, alive, dead, unknown);

  await mapLimit(pending, options.concurrency, async (url) => {
    const result = await probe(url, options.timeoutMs);
    const row = {
      url,
      verdict: result.verdict,
      status: result.status,
      error: result.error || null,
      checked_at: new Date().toISOString()
    };

    checkpoint.set(url, row);
    checkpointWrite = checkpointWrite.then(() =>
      appendFile(CHECKPOINT_PATH, JSON.stringify(row) + "\n", "utf8")
    );
    await checkpointWrite;

    done += 1;
    if (row.verdict === "alive") alive += 1;
    else if (row.verdict === "dead") dead += 1;
    else unknown += 1;

    if (done % 25 === 0 || done === urls.length) {
      progress(done, urls.length, alive, dead, unknown);
    }

    return row;
  });

  process.stdout.write("\n");

  const deadUrls = new Set(
    [...checkpoint.values()]
      .filter((row) => row.verdict === "dead")
      .map((row) => row.url)
  );

  const filteredEntries = parsed.entries.filter((entry) => {
    if (entry.restricted) return false;
    if (isResolverUrl(entry.url, playlistOrigin) && deadUrls.has(entry.url)) return false;
    return true;
  });

  const outputLines = parsed.header.length ? [...parsed.header] : ["#EXTM3U"];
  for (const entry of filteredEntries) {
    outputLines.push(...entry.block);
  }

  await writeFile(FILTERED_PATH, outputLines.join("\n") + "\n", "utf8");

  const deadChannels = resolverEntries
    .filter((entry) => deadUrls.has(entry.url))
    .map((entry) => ({
      name: entry.name,
      group: entry.group,
      url: entry.url,
      result: checkpoint.get(entry.url) || null
    }));

  await writeFile(
    DEAD_PATH,
    JSON.stringify(deadChannels, null, 2) + "\n",
    "utf8"
  );

  const report = {
    source: options.url,
    generated_at: new Date().toISOString(),
    total_entries: parsed.entries.length,
    restricted_entries_removed: restrictedCount,
    resolver_entries: resolverEntries.length,
    unique_resolver_urls: urls.length,
    alive_resolvers: urls.filter((url) => checkpoint.get(url)?.verdict === "alive").length,
    dead_resolvers: urls.filter((url) => checkpoint.get(url)?.verdict === "dead").length,
    unknown_resolvers: urls.filter((url) => checkpoint.get(url)?.verdict === "unknown").length,
    filtered_entries: filteredEntries.length,
    dead_channel_entries_removed: deadChannels.length,
    concurrency: options.concurrency,
    timeout_ms: options.timeoutMs,
    files: {
      filtered_playlist: FILTERED_PATH,
      dead_channels: DEAD_PATH,
      checkpoint: CHECKPOINT_PATH
    }
  };

  await writeFile(REPORT_PATH, JSON.stringify(report, null, 2) + "\n", "utf8");

  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error("\nErro:", error?.stack || error);
  process.exitCode = 1;
});
