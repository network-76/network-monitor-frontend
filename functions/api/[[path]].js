
export async function onRequest(context) {
  const { request, env, params } = context;

  const apiKey = env.MONITOR_API_KEY;
  const workerUrl = env.MONITOR_API_URL;

  if (!apiKey || !workerUrl) {
    return Response.json(
      { error: "Server configuration missing" },
      { status: 500 }
    );
  }

  const path = Array.isArray(params.path)
    ? params.path.join("/")
    : params.path || "";

  const incomingUrl = new URL(request.url);
  const targetUrl = new URL(
    `/api/${path}${incomingUrl.search}`,
    workerUrl
  );

  const headers = new Headers(request.headers);
  headers.set("X-Monitor-Key", apiKey);
  headers.delete("host");

  const response = await fetch(targetUrl, {
    method: request.method,
    headers,
    body: ["GET", "HEAD"].includes(request.method)
      ? undefined
      : request.body,
    redirect: "manual"
  });

  const responseHeaders = new Headers(response.headers);
  responseHeaders.delete("set-cookie");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders
  });
}
