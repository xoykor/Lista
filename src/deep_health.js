// SPDX-License-Identifier: MIT
import { compactVariant, itemNeedsResolver } from "./catalog.js";
import { fetchVariant } from "./hls.js";
import { resolvePlutoStream } from "./providers/pluto.js";

const DEFINITIVE_FAILURES = new Set([
  400, 404, 410, 413, 451, 502, 508
]);

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
    Array.from(
      { length: Math.max(1, Math.min(limit, values.length || 1)) },
      () => run()
    )
  );

  return out;
}

async function materializeVariant(variant, fetchImpl) {
  if (variant?.p !== "pluto") return variant;

  const resolved = await resolvePlutoStream(variant.c, fetchImpl);
  return {
    u: resolved.url,
    r: resolved.referer,
    a: resolved.userAgent
  };
}

async function testVariant(variant, fetchImpl, timeoutMs) {
  try {
    const resolved = await materializeVariant(variant, fetchImpl);
    return await fetchVariant(resolved, fetchImpl, 0, timeoutMs);
  } catch {
    return { ok: false, status: 504 };
  }
}

async function probeItem(item, fetchImpl, timeoutMs) {
  const variants = item.variants.slice(0, 8).map(compactVariant);

  // Fallbacks are independent. Probe them concurrently so one slow/dead
  // source cannot serialize the entire channel health check.
  const results = await Promise.all(
    variants.map((variant) => testVariant(variant, fetchImpl, timeoutMs))
  );
  const statuses = results.map((result) => Number(result?.status || 0));

  if (results.some((result) => result?.ok)) {
    return {
      verdict: "alive",
      statuses
    };
  }

  if (
    statuses.length > 0 &&
    statuses.every((status) => DEFINITIVE_FAILURES.has(status))
  ) {
    return {
      verdict: "dead",
      statuses
    };
  }

  return {
    verdict: "unknown",
    statuses
  };
}

async function runPass(items, fetchImpl, timeoutMs, concurrency) {
  const rows = await mapLimit(items, concurrency, async (item) => {
    const probe = await probeItem(item, fetchImpl, timeoutMs);
    return {
      key: item.key,
      name: item.name,
      verdict: probe.verdict,
      statuses: probe.statuses
    };
  });

  return new Map(rows.map((row) => [row.key, row]));
}

/**
 * Deep-check only items that need the signed resolver.
 *
 * Safety rules:
 * - direct single-URL channels are not touched here;
 * - alive after any fallback is always kept;
 * - unknown/transient failures are always kept;
 * - a channel is removed only if it is definitively dead in two separate passes.
 */
export async function deepPruneResolverItems(
  items,
  {
    fetchImpl = fetch,
    firstTimeoutMs = 2500,
    verifyDeadTimeoutMs = 5000,
    firstConcurrency = 96,
    verifyDeadConcurrency = 32
  } = {}
) {
  const resolverItems = items.filter(itemNeedsResolver);
  const directItems = items.length - resolverItems.length;

  const first = await runPass(
    resolverItems,
    fetchImpl,
    firstTimeoutMs,
    firstConcurrency
  );

  const deadCandidates = resolverItems.filter(
    (item) => first.get(item.key)?.verdict === "dead"
  );

  const verifiedDead = await runPass(
    deadCandidates,
    fetchImpl,
    verifyDeadTimeoutMs,
    verifyDeadConcurrency
  );

  const confirmedDead = new Set(
    deadCandidates
      .filter((item) => verifiedDead.get(item.key)?.verdict === "dead")
      .map((item) => item.key)
  );

  const kept = items.filter((item) => !confirmedDead.has(item.key));

  let alive = 0;
  let unknown = 0;
  for (const item of resolverItems) {
    if (confirmedDead.has(item.key)) continue;

    const row = first.get(item.key);
    const verify = verifiedDead.get(item.key);
    const verdict = verify?.verdict || row?.verdict || "unknown";

    if (verdict === "alive") alive += 1;
    else unknown += 1;
  }

  return {
    items: kept,
    report: {
      resolver_items_checked: resolverItems.length,
      direct_items_skipped: directItems,
      alive_resolvers: alive,
      unknown_resolvers: unknown,
      confirmed_dead_resolvers: confirmedDead.size,
      removed_items: confirmedDead.size,
      dead_channels: deadCandidates
        .filter((item) => confirmedDead.has(item.key))
        .map((item) => ({
          key: item.key,
          name: item.name,
          first: first.get(item.key),
          verify: verifiedDead.get(item.key)
        }))
    }
  };
}
