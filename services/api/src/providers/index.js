// SMS providers. Each one has the same shape:
//
//   provider.name
//   await provider.send({ to, body })
//     → { ok: true,  id }                       accepted by the provider
//     → { ok: false, error, retry: true|false }  rejected; retry = worth trying again later
//
// Choose one with SMS_PROVIDER (see docs/dev-setup.md). Keys come ONLY from environment
// variables: never write them in the code or commit them to GitHub.

/** Development: nothing leaves the server. Messages are marked sent so the simulator shows them. */
export function logProvider() {
  let n = 0;
  return { name: "log", async send() { return { ok: true, id: `log-${Date.now()}-${++n}` }; } };
}

/**
 * Africa's Talking SMS API (also offers USSD in the same CON/END format we use).
 * Check that it covers Liberian networks for your account before relying on it.
 * Env: AT_USERNAME, AT_API_KEY, optional AT_SENDER_ID, AT_SANDBOX=1 for the sandbox.
 */
export function africasTalkingProvider({ username, apiKey, senderId, sandbox = false, fetch = globalThis.fetch }) {
  if (!username || !apiKey) throw new Error("Africa's Talking needs AT_USERNAME and AT_API_KEY");
  const url = sandbox
    ? "https://api.sandbox.africastalking.com/version1/messaging"
    : "https://api.africastalking.com/version1/messaging";
  // 100 Processed, 101 Sent, 102 Queued = accepted. Some failures are worth retrying later.
  const OK = new Set([100, 101, 102]);
  const RETRY = new Set([405, 500, 501, 502]); // insufficient balance, provider or gateway errors
  return {
    name: "africastalking",
    async send({ to, body }) {
      const form = new URLSearchParams({ username, to, message: body });
      if (senderId) form.set("from", senderId);
      let res;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: { apiKey, Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
          body: form
        });
      } catch (err) {
        return { ok: false, error: `network: ${err.message}`, retry: true };
      }
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, retry: res.status >= 500 || res.status === 429 };
      const data = await res.json().catch(() => null);
      const r = data?.SMSMessageData?.Recipients?.[0];
      if (!r) return { ok: false, error: data?.SMSMessageData?.Message ?? "no recipient in response", retry: false };
      if (OK.has(r.statusCode)) return { ok: true, id: r.messageId };
      return { ok: false, error: `${r.statusCode} ${r.status}`, retry: RETRY.has(r.statusCode) };
    }
  };
}

/**
 * Any provider (or a telco) with a simple JSON HTTP API.
 * Sends POST SMS_HTTP_URL  { to, message, from }  with "Authorization: Bearer SMS_HTTP_TOKEN".
 * Expects a 2xx answer, optionally JSON with "id" or "messageId".
 * If your provider's format is different, copy this function and adjust it.
 */
export function httpProvider({ url, token, senderId, fetch = globalThis.fetch }) {
  if (!url) throw new Error("The http SMS provider needs SMS_HTTP_URL");
  return {
    name: "http",
    async send({ to, body }) {
      let res;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
          body: JSON.stringify({ to, message: body, ...(senderId ? { from: senderId } : {}) })
        });
      } catch (err) {
        return { ok: false, error: `network: ${err.message}`, retry: true };
      }
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, retry: res.status >= 500 || res.status === 429 };
      const data = await res.json().catch(() => ({}));
      return { ok: true, id: String(data.id ?? data.messageId ?? "") || null };
    }
  };
}

/** Pick the provider from environment variables. Throws with a clear message if settings are missing. */
export function providerFromEnv(env = process.env) {
  const name = env.SMS_PROVIDER ?? "log";
  if (name === "log") return logProvider();
  if (name === "africastalking")
    return africasTalkingProvider({ username: env.AT_USERNAME, apiKey: env.AT_API_KEY, senderId: env.AT_SENDER_ID, sandbox: env.AT_SANDBOX === "1" });
  if (name === "http") return httpProvider({ url: env.SMS_HTTP_URL, token: env.SMS_HTTP_TOKEN, senderId: env.SMS_SENDER_ID });
  throw new Error(`Unknown SMS_PROVIDER "${name}". Use log, africastalking or http.`);
}
