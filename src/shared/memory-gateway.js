export const DEFAULT_MEMORY_GATEWAY_URL = "https://gea.synear.cn";

function privateIpv4(hostname) {
  if (!/^(0|[1-9]\d{0,2})(\.(0|[1-9]\d{0,2})){3}$/.test(hostname)) return false;
  const [first, second, ...rest] = hostname.split(".").map(Number);
  if ([first, second, ...rest].some((octet) => octet > 255)) return false;
  return (
    first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 100 && second >= 64 && second <= 127)
  );
}

export function resolveMemoryGatewayUrl(value, allowPrivateHttp = false) {
  if (typeof allowPrivateHttp !== "boolean")
    throw Error("INVALID_MEMORY_GATEWAY_ALLOW_PRIVATE_HTTP");
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string") throw Error("INVALID_MEMORY_GATEWAY_URL");
  let url;
  try {
    url = new URL(value);
  } catch {
    throw Error("INVALID_MEMORY_GATEWAY_URL");
  }
  if (
    /[?#]/.test(value) ||
    url.pathname !== "/" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        (["127.0.0.1", "[::1]"].includes(url.hostname) ||
          (allowPrivateHttp === true &&
            !/[?#]/.test(value) &&
            value.match(/^http:\/\/([^:/?#]+)(?::\d+)?(?:[/?#]|$)/i)?.[1] === url.hostname &&
            privateIpv4(url.hostname)))
      ))
  )
    throw Error("INVALID_MEMORY_GATEWAY_URL");
  return url.href.replace(/\/$/, "");
}
