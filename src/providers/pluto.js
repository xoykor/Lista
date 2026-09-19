// SPDX-License-Identifier: MIT

const BOOT_URL = "https://boot.pluto.tv/v4/start";
const GUIDE_URL =
  "https://service-channels.clusters.pluto.tv/v2/guide/channels" +
  "?channelIds=&offset=0&limit=1000&sort=number%3Aasc";
const LEGACY_CHANNELS_URL = "https://api.pluto.tv/v2/channels.json";
const STITCHER_FALLBACK =
  "https://cfd-v4-service-channel-stitcher-use1-1.prd.pluto.tv";
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
  "Chrome/122 Safari/537.36";

function randomClientId() {
  if (globalThis.crypto?.randomUUID) {
    return crypto.randomUUID().replace(/-/g, "");
  }

  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function commonHeaders() {
  return {
    "Accept": "*/*",
    "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.5",
    "Origin": "https://pluto.tv",
    "Referer": "https://pluto.tv/",
    "User-Agent": USER_AGENT,
    "Cache-Control": "no-cache"
  };
}

function bootRequestUrl() {
  const url = new URL(BOOT_URL);
  url.searchParams.set("appName", "web");
  url.searchParams.set("appVersion", "8.0.0");
  url.searchParams.set("deviceVersion", "122.0.0");
  url.searchParams.set("deviceModel", "web");
  url.searchParams.set("deviceMake", "chrome");
  url.searchParams.set("deviceType", "web");
  url.searchParams.set("clientID", randomClientId());
  url.searchParams.set("clientModelNumber", "1.0.0");
  url.searchParams.set("serverSideAds", "false");
  url.searchParams.set("drmCapabilities", "widevine:L3");
  return url;
}

function tokenExpiryMs(token) {
  try {
    const payload = token.split(".")[1];
    if (!payload) return Date.now() + 5 * 60 * 1000;

    let base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    while (base64.length % 4) base64 += "=";

    const json = JSON.parse(atob(base64));
    if (typeof json.exp === "number") return json.exp * 1000;
  } catch {
    // A malformed/opaque token can still be used; just cache it briefly.
  }

  return Date.now() + 5 * 60 * 1000;
}

export async function bootPluto(fetchImpl = fetch) {
  const response = await fetchImpl(bootRequestUrl(), {
    headers: commonHeaders(),
    redirect: "follow",
    cf: { cacheTtl: 0, cacheEverything: false }
  });

  if (!response.ok) {
    throw new Error("Pluto boot HTTP " + response.status);
  }

  const data = await response.json();
  const token = data?.sessionToken;
  if (typeof token !== "string" || !token) {
    throw new Error("Pluto boot without anonymous session token");
  }

  const stitcher =
    typeof data?.servers?.stitcher === "string" && data.servers.stitcher
      ? data.servers.stitcher.replace(/\/$/, "")
      : STITCHER_FALLBACK;

  const stitcherParams =
    typeof data?.stitcherParams === "string"
      ? data.stitcherParams.replace(/^[?&]+/, "")
      : "";

  return {
    token,
    stitcher,
    stitcherParams,
    expiresAt: tokenExpiryMs(token)
  };
}

function channelLogo(channel) {
  if (Array.isArray(channel?.images)) {
    for (const preferred of ["colorLogoPNG", "logo"]) {
      const image = channel.images.find(
        (candidate) =>
          candidate?.type === preferred &&
          typeof candidate?.url === "string" &&
          candidate.url
      );
      if (image) return image.url;
    }
  }

  if (typeof channel?.colorLogoPNG?.path === "string") {
    return channel.colorLogoPNG.path;
  }
  if (typeof channel?.logo?.path === "string") {
    return channel.logo.path;
  }
  return "";
}

function channelCategory(channel) {
  for (const key of ["category", "genre", "group"]) {
    const value = channel?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (value && typeof value.name === "string" && value.name.trim()) {
      return value.name.trim();
    }
  }
  return "Pluto TV";
}

function channelArray(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

async function fetchGuide(session, fetchImpl) {
  const headers = {
    ...commonHeaders(),
    "Authorization": "Bearer " + session.token
  };

  const current = await fetchImpl(GUIDE_URL, {
    headers,
    redirect: "follow",
    cf: { cacheTtl: 0, cacheEverything: false }
  });

  if (current.ok) return current.json();

  // Keep the legacy API only as a compatibility fallback. It is intentionally
  // not the primary source because the guide service carries the current lineup.
  const legacy = await fetchImpl(LEGACY_CHANNELS_URL, {
    headers: commonHeaders(),
    redirect: "follow",
    cf: { cacheTtl: 0, cacheEverything: false }
  });

  if (!legacy.ok) {
    throw new Error(
      "Pluto guide HTTP " + current.status + "; legacy HTTP " + legacy.status
    );
  }

  return legacy.json();
}

export async function fetchPlutoCatalog(source, fetchImpl = fetch) {
  const session = await bootPluto(fetchImpl);
  const payload = await fetchGuide(session, fetchImpl);
  const channels = channelArray(payload);
  const items = [];

  for (const channel of channels) {
    const id =
      typeof channel?.id === "string" && channel.id
        ? channel.id
        : typeof channel?._id === "string"
          ? channel._id
          : "";
    const name = typeof channel?.name === "string" ? channel.name.trim() : "";

    if (!id || !name) continue;

    items.push({
      name,
      logo: channelLogo(channel),
      group: channelCategory(channel),
      variants: [{
        provider: "pluto",
        channelId: id,
        origin: source.id
      }]
    });
  }

  return items;
}

export async function resolvePlutoStream(channelId, fetchImpl = fetch) {
  if (!channelId || typeof channelId !== "string") {
    throw new Error("invalid Pluto channel id");
  }

  const session = await bootPluto(fetchImpl);
  const url = new URL(
    session.stitcher +
    "/v2/stitch/hls/channel/" +
    encodeURIComponent(channelId) +
    "/master.m3u8"
  );

  url.searchParams.set("jwt", session.token);
  url.searchParams.set("masterJWTPassthrough", "true");

  if (session.stitcherParams) {
    const extra = new URLSearchParams(session.stitcherParams);
    for (const [key, value] of extra) {
      if (!url.searchParams.has(key)) url.searchParams.append(key, value);
    }
  }

  return {
    url: url.href,
    referer: "https://pluto.tv/",
    userAgent: USER_AGENT,
    expiresAt: session.expiresAt
  };
}
