// SPDX-License-Identifier: MIT
import { USER_AGENT } from "./upstream.js";

const HARD_FAILURES = new Set([400, 401, 403, 404, 410, 451]);

function headersFor(variant) {
  const headers = new Headers({
    "Accept": "*/*",
    "Accept-Encoding": "identity",
    "Range": "bytes=0-0",
    "User-Agent": variant.userAgent || USER_AGENT
  });
  if (variant.referer) headers.set("Referer", variant.referer);
  return headers;
}

function hostOf(url) {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return "";
  }
}

async function probeVariant(variant, fetchImpl, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("timeout"), timeoutMs);

  try {
    const response = await fetchImpl(variant.url, {
      method: "GET",
      headers: headersFor(variant),
      redirect: "follow",
      signal: controller.signal
    });

    if (response.body) response.body.cancel();

    if (response.status >= 200 && response.status < 400) {
      return { verdict: "healthy", status: response.status };
    }

    if (HARD_FAILURES.has(response.status)) {
      return { verdict: "hard-fail", status: response.status };
    }

    return { verdict: "unknown", status: response.status };
  } catch {
    return { verdict: "unknown", status: 0 };
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

  const count = Math.max(1, Math.min(limit, values.length));
  await Promise.all(Array.from({ length: count }, () => run()));
  return results;
}

/**
 * Probe only large hosts. A host is removed only when every sampled URL
 * returns a hard client/auth/not-found failure. Timeouts and 5xx responses are
 * deliberately treated as unknown so a temporary outage never purges a host.
 */
export async function filterUnhealthyHosts(
  items,
  fetchImpl = fetch,
  {
    minHostVariants = 20,
    samplesPerHost = 4,
    concurrency = 12,
    timeoutMs = 5000
  } = {}
) {
  const byHost = new Map();

  for (const item of items) {
    for (const variant of item.variants || []) {
      if (!variant?.url) continue;
      const host = hostOf(variant.url);
      if (!host) continue;

      let bucket = byHost.get(host);
      if (!bucket) {
        bucket = { host, variants: [], total: 0 };
        byHost.set(host, bucket);
      }

      bucket.total += 1;
      if (bucket.variants.length < samplesPerHost) {
        bucket.variants.push(variant);
      }
    }
  }

  const candidates = [...byHost.values()]
    .filter((entry) => entry.total >= minHostVariants && entry.variants.length >= 3);

  const reports = await mapLimit(candidates, concurrency, async (entry) => {
    const samples = [];
    for (const variant of entry.variants) {
      samples.push(await probeVariant(variant, fetchImpl, timeoutMs));
    }

    const hardFailures = samples.filter((sample) => sample.verdict === "hard-fail").length;
    const healthy = samples.filter((sample) => sample.verdict === "healthy").length;
    const drop = hardFailures === samples.length && healthy === 0;

    return {
      host: entry.host,
      variants: entry.total,
      drop,
      samples
    };
  });

  const droppedHosts = new Set(
    reports.filter((entry) => entry.drop).map((entry) => entry.host)
  );

  let removedVariants = 0;
  let removedItems = 0;

  const filteredItems = [];
  for (const item of items) {
    const variants = (item.variants || []).filter((variant) => {
      if (!variant?.url) return true;
      const drop = droppedHosts.has(hostOf(variant.url));
      if (drop) removedVariants += 1;
      return !drop;
    });

    if (!variants.length) {
      removedItems += 1;
      continue;
    }

    filteredItems.push({ ...item, variants });
  }

  return {
    items: filteredItems,
    report: {
      checked_hosts: reports.length,
      dropped_hosts: [...droppedHosts],
      removed_variants: removedVariants,
      removed_items: removedItems,
      hosts: reports
    }
  };
}
