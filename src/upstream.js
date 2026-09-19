// SPDX-License-Identifier: MIT
import { githubContentsUrl, rawUrl } from "./sources.js";

export const USER_AGENT = "Lista-Auto-Healing/0.1";

function timeoutSignal(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("timeout"), ms);
  return { signal: controller.signal, cancel: () => clearTimeout(timer) };
}

export async function currentRevision(source, fetchImpl = fetch) {
  const timer = timeoutSignal(12000);
  try {
    const response = await fetchImpl(githubContentsUrl(source), {
      headers: {
        "Accept": "application/vnd.github+json",
        "User-Agent": USER_AGENT,
        "Cache-Control": "no-cache"
      },
      signal: timer.signal,
      cf: { cacheTtl: 0, cacheEverything: false }
    });

    if (!response.ok) throw new Error(source.id + ": metadata HTTP " + response.status);
    const value = await response.json();
    if (!value || typeof value.sha !== "string") throw new Error(source.id + ": metadata without SHA");

    return { sha: value.sha, size: Number(value.size || 0), raw: rawUrl(source) };
  } finally {
    timer.cancel();
  }
}

export async function fetchCurrentSource(source, fetchImpl = fetch) {
  const timer = timeoutSignal(30000);
  try {
    const response = await fetchImpl(rawUrl(source), {
      headers: {
        "Accept": "text/plain,*/*",
        "User-Agent": USER_AGENT,
        "Cache-Control": "no-cache"
      },
      signal: timer.signal,
      cf: { cacheTtl: 0, cacheEverything: false }
    });

    if (!response.ok || !response.body) throw new Error(source.id + ": raw HTTP " + response.status);
    return response;
  } catch (error) {
    timer.cancel();
    throw error;
  }
}
