import { rateLimit } from "elysia-rate-limit";

const errResponse = (msg: string) =>
  new Response(JSON.stringify({ error: msg }), {
    status: 429,
    headers: { "Content-Type": "application/json" },
  });

// Generator function to get client identifier from headers or connection info
const getClientId = (req: Request) => {
  // Try to get IP from various headers (works with proxies like nginx, cloudflare, etc.)
  const headers = req.headers;
  const forwarded = headers.get("x-forwarded-for");
  const realIp = headers.get("x-real-ip");
  const cfConnectingIp = headers.get("cf-connecting-ip");

  // Use the first available IP source
  const ip = cfConnectingIp || realIp || forwarded?.split(",")[0]?.trim() || "unknown";
  return ip;
};

// scoping: "scoped" limits only the route group that mounts the plugin —
// the default ("global") registers an app-wide onRequest hook, which made
// the 10/min auth limit apply to every endpoint.
export const authRateLimit = rateLimit({
  max: 10,
  duration: 60_000,
  generator: getClientId,
  scoping: "scoped",
  errorResponse: errResponse("Too many auth attempts. Wait 1 minute."),
});
export const paymentRateLimit = rateLimit({
  max: 30,
  duration: 60_000,
  generator: getClientId,
  scoping: "scoped",
  errorResponse: errResponse("Too many payment requests."),
});
export const generalRateLimit = rateLimit({
  max: 100,
  duration: 60_000,
  generator: getClientId,
  scoping: "scoped",
  errorResponse: errResponse("Rate limit exceeded."),
});
