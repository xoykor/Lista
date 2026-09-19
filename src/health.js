// SPDX-License-Identifier: MIT
import { fetchVariant } from "./hls.js";

/*
 * Many IPTV lists contain hundreds of thousands of entries backed by only a
 * small number of upstream accounts/pools. Testing every channel would be too
 * expensive, so we classify URLs by stream pool and probe representative
 * samples before publishing the catalogue.
 *
 * Examples:
 *   host/user/pass/123.ts        -> host/user/pass
 *   host/live/user/pass/123.ts   -> host/live/user/pass
 *   host/movie/user/pass/123.mp4 -> host/movie/user/pass
 *   host/ss/ae.txt               -> host/ss
 */
export function streamPoolKey(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const parts = url.pathname.split("/").filter(Boolean);
    const host = url.host.toLowerCase();

    if (!parts.length) return host;

    const kind = parts[0].toLowerCase();
    if (["live", "movie", "series"].includes(kind) && parts.length >= 3) {
      return [host, parts[0], parts[1], parts[2]].join("/");
    }

    if (parts.length >= 3) {
      return [host, parts[0], parts[1]].join("/");
    }

    return [host, parts[0]].join("/");
  } catch {
    return "";
  }
}

async function mapLimit(values, limit, worker) {
  const out = new Array(values.length);
  let next = 0;

  async function run() {
    while (true) {
      const index = next++;
      if (index >= values.length) return;
      out[index] = await worker(values[index], index);
    }
  }

  const workers = Math.max(1, Math.min(limit, values.length || 1));
  await Promise.all(Array.from({ length: workers }, () => run()));
  return out;
}

function compactVariant(variant) {
  return {
    u: variant.url,
    r: variant.referer || undefined,
    a: variant.userAgent || undefined
  };
}

export async function pruneDeadStreamPools(
  items,
  {
    fetchImpl = fetch,
    sampleCount = 3,
    minPoolSize = 3,
    concurrency = 16
  } = {}
) {
  const pools = new Map();

  for (const item of items) {
    for (const variant of item.variants || []) {
      if (!variant?.url) continue;
      const key = streamPoolKey(variant.url);
      if (!key) continue;

      let pool = pools.get(key);
      if (!pool) {
        pool = { key, total: 0, samples: [] };
        pools.set(key, pool);
      }

      pool.total += 1;
      if (pool.samples.length < sampleCount) {
        pool.samples.push(variant);
      }
    }
  }

  const candidates = [...pools.values()].filter(
    (pool) => pool.total >= minPoolSize && pool.samples.length >= Math.min(sampleCount, pool.total)
  );

  const reports = await mapLimit(candidates, concurrency, async (pool) => {
    let healthy = 0;
    let failed = 0;

    for (const variant of pool.samples) {
      const result = await fetchVariant(compactVariant(variant), fetchImpl);

      if (result.ok) {
        healthy += 1;
      } else if ([400, 401, 403, 404, 410, 451, 502, 508].includes(result.status)) {
        failed += 1;
      }
    }

    return {
      key: pool.key,
      total: pool.total,
      healthy,
      failed,
      sampled: pool.samples.length,
      dead: healthy === 0 && failed === pool.samples.length
    };
  });

  const deadPools = new Set(
    reports.filter((report) => report.dead).map((report) => report.key)
  );

  let removedVariants = 0;
  let removedItems = 0;
  const keptItems = [];

  for (const item of items) {
    const variants = (item.variants || []).filter((variant) => {
      if (!variant?.url) return true;
      const key = streamPoolKey(variant.url);
      const remove = key && deadPools.has(key);
      if (remove) removedVariants += 1;
      return !remove;
    });

    if (!variants.length) {
      removedItems += 1;
      continue;
    }

    keptItems.push({ ...item, variants });
  }

  return {
    items: keptItems,
    report: {
      pools_checked: reports.length,
      pools_dead: deadPools.size,
      removed_variants: removedVariants,
      removed_items: removedItems,
      dead_pools: reports.filter((report) => report.dead)
    }
  };
}
