// SPDX-License-Identifier: MIT

function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 32768;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function base64urlEncode(bytes) {
  return bytesToBase64(bytes)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64urlDecode(value) {
  let base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4) base64 += "=";
  return base64ToBytes(base64);
}

export function encodeConfig(config) {
  return base64urlEncode(new TextEncoder().encode(JSON.stringify(config)));
}

function validVariant(variant) {
  if (!variant || typeof variant !== "object") return false;

  if (typeof variant.u === "string" && /^https?:\/\//i.test(variant.u)) {
    return true;
  }

  return (
    variant.p === "pluto" &&
    typeof variant.c === "string" &&
    /^[A-Za-z0-9_-]{4,128}$/.test(variant.c)
  );
}

export function decodeConfig(payload) {
  if (!payload || payload.length > 16384) throw new Error("invalid token");
  const value = JSON.parse(new TextDecoder().decode(base64urlDecode(payload)));

  if (!value || !Array.isArray(value.v) || value.v.length < 1 || value.v.length > 16) {
    throw new Error("invalid config");
  }

  for (const variant of value.v) {
    if (!validVariant(variant)) throw new Error("invalid variant");
  }
  return value;
}

async function hmac(secret, payload) {
  if (!secret) throw new Error("TOKEN_SECRET is required");

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  return new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload))
  );
}

function equalBytes(left, right) {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left[i] ^ right[i];
  return diff === 0;
}

export async function signConfig(config, secret) {
  const payload = encodeConfig(config);
  const signature = base64urlEncode(await hmac(secret, payload));
  return payload + "." + signature;
}

export async function verifyConfig(token, secret) {
  if (!token || token.length > 16480) throw new Error("invalid token");

  const separator = token.lastIndexOf(".");
  if (separator <= 0 || separator === token.length - 1) {
    throw new Error("unsigned token");
  }

  const payload = token.slice(0, separator);
  const supplied = base64urlDecode(token.slice(separator + 1));
  const expected = await hmac(secret, payload);

  if (!equalBytes(supplied, expected)) throw new Error("invalid signature");
  return decodeConfig(payload);
}

export function stateName(token) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < token.length; i += 1) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return "channel-" + (hash >>> 0).toString(16).padStart(8, "0");
}
