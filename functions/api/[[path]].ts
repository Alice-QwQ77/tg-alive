interface Env {
  TG_GATEWAY: Fetcher;
}

export const onRequest: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.TG_GATEWAY) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: "missing_service_binding",
        binding: "TG_GATEWAY"
      }),
      {
        status: 500,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store"
        }
      }
    );
  }

  const incoming = new URL(request.url);
  const serviceUrl = new URL(incoming.pathname + incoming.search, "https://tg-gateway.internal");

  return env.TG_GATEWAY.fetch(new Request(serviceUrl, request));
};
