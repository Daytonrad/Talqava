// HTTP calls with stored secrets. The model writes {{secret:NAME}}; the value
// is filled in here, outside its view, and only for the host the secret is tied to.
import { clip, defineTool } from "../tooling.ts";
import type { MaybePromise, Secret, Tool } from "../types.ts";

type Secrets = Record<string, Secret>;
const PLACEHOLDER = /\{\{secret:([A-Za-z0-9_]+)\}\}/g;
// Cloud metadata addresses, which hand out credentials to anything that asks.
const BLOCKED_HOSTS = /^(169\.254\.|metadata\.google\.internal$|fd00:ec2::)/i;

export function fillSecrets(text: string, host: string, secrets: Secrets): string {
  return String(text).replace(PLACEHOLDER, (_, name: string) => {
    const secret = secrets[name];
    if (!secret) throw new Error(`No secret named ${name}. The user can add it under Settings.`);
    const allowed = secret.host.toLowerCase();
    if (host !== allowed && !host.endsWith(`.${allowed}`)) {
      throw new Error(`Secret ${name} may only be sent to ${secret.host}, not ${host}.`);
    }
    return secret.value;
  });
}

interface HttpInput {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";
  url: string;
  headers?: Record<string, string>;
  body?: string;
}

export function httpTool(getSecrets: () => MaybePromise<Secrets>): Tool {
  return defineTool<HttpInput>({
    name: "http_request",
    description:
      "Call an HTTP API. To use a stored API key, write {{secret:NAME}} in the URL, a header value or the body; it is filled in outside your view and only for the host that secret is tied to. You never see secret values.",
    properties: {
      method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"] },
      url: { type: "string" },
      headers: { type: "object", description: "Header names to values." },
      body: { type: "string", description: "Request body as text (JSON should be a JSON string)." },
    },
    required: ["method", "url"],
    needsApproval: (input) => !["GET", "HEAD"].includes(input.method),
    async run(input, { signal }) {
      const secrets = await getSecrets();
      // The host is fixed before any secret is filled in, so a secret cannot change where it is sent.
      const host = new URL(input.url.replace(PLACEHOLDER, "x")).hostname.toLowerCase();
      if (BLOCKED_HOSTS.test(host)) throw new Error(`Requests to ${host} are not allowed.`);
      const url = new URL(fillSecrets(input.url, host, secrets));
      if (url.hostname.toLowerCase() !== host) throw new Error("A secret may not change the host of the URL.");
      if (!["http:", "https:"].includes(url.protocol)) throw new Error("Only http and https URLs are supported.");

      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(input.headers ?? {})) headers[key] = fillSecrets(value, host, secrets);
      const body = input.body === undefined ? undefined : fillSecrets(input.body, host, secrets);

      const response = await fetch(url, {
        method: input.method,
        headers,
        body: ["GET", "HEAD"].includes(input.method) ? undefined : body,
        signal: AbortSignal.any([AbortSignal.timeout(60_000), signal]),
      });
      let text = await response.text();
      for (const secret of Object.values(secrets)) {
        if (secret.value) text = text.split(secret.value).join("[secret]");
      }
      return `HTTP ${response.status} ${response.statusText}\ncontent-type: ${response.headers.get("content-type") || "unknown"}\n\n${clip(text, 20_000)}`;
    },
  });
}
