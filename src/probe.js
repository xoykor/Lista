// SPDX-License-Identifier: MIT
import { fetchVariant } from "./hls.js";
import { resolvePlutoStream } from "./providers/pluto.js";

const DEFINITIVE_FAILURES = new Set([
  400, 401, 403, 404, 410, 413, 451, 502, 508
]);

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

export async function probeConfig(
  config,
  {
    fetchImpl = fetch,
    timeoutMs = 5000
  } = {}
) {
  const variants = Array.isArray(config?.v) ? config.v : [];
  if (!variants.length) return { verdict: "dead", status: 502, results: [] };

  // HEAD health checks are intentionally stateless. Probe all fallbacks in
  // parallel so a dead first source cannot block a healthy later source.
  const results = await Promise.all(
    variants.map((variant) => testVariant(variant, fetchImpl, timeoutMs))
  );

  if (results.some((result) => result?.ok)) {
    return { verdict: "alive", status: 200, results };
  }

  if (results.every((result) => DEFINITIVE_FAILURES.has(Number(result?.status || 0)))) {
    return { verdict: "dead", status: 502, results };
  }

  return { verdict: "unknown", status: 504, results };
}

export async function resolveConfigOnce(
  config,
  {
    fetchImpl = fetch,
    timeoutMs = 7000
  } = {}
) {
  const variants = Array.isArray(config?.v) ? config.v : [];

  for (const variant of variants) {
    const result = await testVariant(variant, fetchImpl, timeoutMs);
    if (result?.ok) return result;
  }

  return null;
}
