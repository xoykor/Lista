// SPDX-License-Identifier: MIT

/*
 * Worker mínimo de publicação.
 *
 * Ele não armazena, não reconstrói e não faz proxy da playlist. O catálogo
 * pesado permanece no GitHub e o Worker apenas mantém um URL estável. Assim,
 * cada atualização da branch static-fallback fica disponível imediatamente
 * sem upload de dezenas de MB para Cloudflare e sem subrequests do Worker.
 */

const RAW_BASE =
  "https://raw.githubusercontent.com/xoykor/Lista/static-fallback";

function redirect(path) {
  return new Response(null, {
    status: 307,
    headers: {
      Location: RAW_BASE + path,
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*"
    }
  });
}

function json(value) {
  return new Response(JSON.stringify(value, null, 2) + "\n", {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*"
    }
  });
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/" && (request.method === "GET" || request.method === "HEAD")) {
      if (request.method === "HEAD") return new Response(null, { status: 200 });
      return json({
        service: "Lista",
        list: "/list.m3u8",
        status: "/status.json",
        health: "/healthz",
        source: RAW_BASE + "/list.m3u8",
        mode: "redirect",
        cloudflare_storage: false
      });
    }

    if (url.pathname === "/healthz" && (request.method === "GET" || request.method === "HEAD")) {
      return new Response(request.method === "HEAD" ? null : "ok\n", {
        status: 200,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store"
        }
      });
    }

    if (
      (url.pathname === "/list.m3u8" ||
       url.pathname === "/live.m3u8" ||
       url.pathname === "/vod.m3u8") &&
      (request.method === "GET" || request.method === "HEAD")
    ) {
      return redirect("/list.m3u8");
    }

    if (url.pathname === "/status.json" && (request.method === "GET" || request.method === "HEAD")) {
      return redirect("/status.json");
    }

    return new Response("not found\n", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8" }
    });
  }
};
