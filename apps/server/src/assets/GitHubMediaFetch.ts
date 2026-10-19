import * as Mime from "effect/http/Mime";
import { githubMediaFileName } from "@t3tools/shared/githubMedia";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as GitHubCredentials from "@t3tools/source-control-github/server/GitHubCredentials";
import * as GitHubRest from "@t3tools/source-control-github/server/GitHubRest";

import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";

/**
 * Everything a redirect leads to — the presigned object stores GitHub hands assets off to —
 * authorizes with its own signature, and some of them reject a request that also carries a
 * bearer token.
 */
const CREDENTIALED_HOSTS = new Set([
  "github.com",
  "www.github.com",
  "raw.githubusercontent.com",
  "media.githubusercontent.com",
]);
const isCredentialedHost = (url: string) => {
  try {
    const target = new URL(url);
    return (
      target.protocol === "https:" &&
      target.port === "" &&
      CREDENTIALED_HOSTS.has(target.hostname.toLowerCase())
    );
  } catch {
    return false;
  }
};

const MAX_REDIRECTS = 3;
const MANUAL_REDIRECT: RequestInit = { redirect: "manual" };
const FORWARDED_REQUEST_HEADERS = ["range", "if-range"] as const;
const FORWARDED_RESPONSE_HEADERS = [
  "content-type",
  "content-length",
  "content-range",
  "accept-ranges",
  "etag",
  "last-modified",
] as const;
const MEDIA_CONTENT_TYPE_PATTERN = /^(?:image|video|audio)\/[\w!#$&^.+-]+$/i;
const SVG_CONTENT_TYPE = "image/svg+xml";
// An SVG is a document: same policy the asset route gives a workspace SVG, so one embedded in a
// body cannot run script against this origin.
const SVG_CONTENT_SECURITY_POLICY = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

type GitHubMediaLocation = {
  readonly url: string;
  readonly cwd: string;
  readonly repository?: string;
};

class GitHubMediaFetchError extends Schema.TaggedError<GitHubMediaFetchError>()(
  "GitHubMediaFetchError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to fetch GitHub media.";
  }
}

export class GitHubMediaFetch extends Context.Service<
  GitHubMediaFetch,
  {
    readonly fetch: (
      asset: GitHubMediaLocation,
      requestHeaders: Readonly<Record<string, string | undefined>>,
    ) => Effect.Effect<
      HttpClientResponse.HttpClientResponse | null,
      GitHubMediaFetchError,
      Scope.Scope
    >;
  }
>()("t3/assets/GitHubMediaFetch") {}

const SIGNED_URL_CACHE_TTL_MS = 4 * 60_000;
const SIGNED_URL_CACHE_MAX_ENTRIES = 64;

const make = Effect.gen(function* () {
  const credentials = yield* GitHubCredentials.GitHubCredentials;
  const rest = yield* GitHubRest.GitHubRest;
  const identities = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
  const httpClient = HttpClient.withScope(yield* HttpClient.HttpClient);
  const signedUrls = new Map<string, { readonly at: number; readonly url: string }>();

  const fetchFollowingRedirects = Effect.fnUntraced(function* (
    url: string,
    headers: Record<string, string>,
    token: Redacted.Redacted<string> | null,
  ) {
    let target = url;
    for (let hop = 0; ; hop += 1) {
      const parsed = URL.parse(target);
      if (parsed === null || parsed.protocol !== "https:" || parsed.username || parsed.password) {
        return null;
      }
      const authorization =
        token !== null && isCredentialedHost(target) ? `Bearer ${Redacted.value(token)}` : null;
      const response: HttpClientResponse.HttpClientResponse = yield* httpClient
        .execute(
          HttpClientRequest.get(target).pipe(
            HttpClientRequest.setHeaders({
              ...headers,
              // The bytes are streamed straight through, so never let an encoding layer in.
              "accept-encoding": "identity",
              ...(authorization === null ? {} : { authorization }),
            }),
          ),
        )
        .pipe(
          Effect.provideService(FetchHttpClient.RequestInit, MANUAL_REDIRECT),
          // Signed query strings must never be added to HTTP tracing spans.
          Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
          Effect.mapError((cause) => new GitHubMediaFetchError({ cause })),
        );
      const location = response.headers.location;
      if (response.status < 300 || response.status >= 400) return response;
      if (!location || hop >= MAX_REDIRECTS) return null;
      const next = URL.parse(location, target);
      if (next === null || next.protocol !== "https:") return null;
      target = next.toString();
    }
  });

  const renderSignedUrl = Effect.fnUntraced(function* (url: string, repository: string) {
    const rendered = yield* rest
      .rest({
        host: "github.com",
        operation: "renderMarkdown",
        method: "POST",
        path: "markdown",
        accept: "text/html",
        body: { text: `![](${url})`, mode: "gfm", context: repository },
      })
      .pipe(Effect.orElseSucceed(() => null));
    if (
      rendered === null ||
      rendered.status !== 200 ||
      rendered.truncated ||
      rendered.invalidUtf8
    ) {
      return null;
    }
    for (const match of rendered.body.matchAll(/<img\b[^>]*\ssrc\s*=\s*(["'])(.*?)\1/giu)) {
      const signed = URL.parse(match[2]?.replaceAll("&amp;", "&") ?? "");
      if (
        signed?.protocol === "https:" &&
        signed.hostname === "private-user-images.githubusercontent.com" &&
        signed.port === "" &&
        signed.username === "" &&
        signed.password === "" &&
        signed.searchParams.get("jwt")
      ) {
        return signed.toString();
      }
    }
    return null;
  });

  const fetch: GitHubMediaFetch["Service"]["fetch"] = Effect.fn("GitHubMediaFetch.fetch")(
    function* (asset, requestHeaders) {
      // Read on every request so a login or account change takes effect immediately.
      const credential = yield* credentials
        .get("github.com")
        .pipe(Effect.orElseSucceed(() => null));
      const forwarded: Record<string, string> = {};
      for (const name of FORWARDED_REQUEST_HEADERS) {
        const value = requestHeaders[name];
        if (value !== undefined) forwarded[name] = value;
      }
      const target = URL.parse(asset.url);
      const attachment =
        target?.protocol === "https:" &&
        target.hostname === "github.com" &&
        target.port === "" &&
        target.username === "" &&
        target.password === "" &&
        /^\/(?:user-attachments\/assets\/[\w-]+|[^/]+\/[^/]+\/assets\/\d+\/[\w-]+)$/u.test(
          target.pathname,
        );
      let repository: string | undefined;
      if (attachment && credential !== null) {
        repository = asset.repository;
        if (repository === undefined) {
          repository = /^\/([^/]+\/[^/]+)\/assets\//u.exec(target.pathname)?.[1];
          if (repository === undefined) {
            const identity = yield* identities.resolve(asset.cwd);
            repository = /^github\.com\/([^/]+\/[^/]+)$/u.exec(identity?.canonicalKey ?? "")?.[1];
          }
        }
      }
      // An unusable explicit context must not fall back to an unrelated checkout.
      const cacheKey =
        credential !== null && repository !== undefined && /^[\w.-]+\/[\w.-]+$/u.test(repository)
          ? [credential.fingerprint, repository, asset.url].map(encodeURIComponent).join("|")
          : null;
      const now = yield* Clock.currentTimeMillis;
      const cached = cacheKey === null ? undefined : signedUrls.get(cacheKey);
      let response: HttpClientResponse.HttpClientResponse | null;
      if (cacheKey !== null && cached !== undefined && now - cached.at < SIGNED_URL_CACHE_TTL_MS) {
        response = yield* fetchFollowingRedirects(cached.url, forwarded, null);
        if (response === null || response.status >= 400) signedUrls.delete(cacheKey);
        if (response?.status !== 403) return response;
      } else {
        if (cacheKey !== null) signedUrls.delete(cacheKey);
        response = yield* fetchFollowingRedirects(asset.url, forwarded, credential?.token ?? null);
        if (
          response?.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "text/html"
        ) {
          return response;
        }
      }
      if (cacheKey === null || repository === undefined || credential === null) return response;
      const signed = yield* renderSignedUrl(asset.url, repository);
      if (signed === null) return response;
      const media = yield* fetchFollowingRedirects(signed, forwarded, null);
      if (
        (media?.status === 200 || media?.status === 206) &&
        MEDIA_CONTENT_TYPE_PATTERN.test(
          media.headers["content-type"]?.split(";", 1)[0]?.trim() ?? "",
        )
      ) {
        // The REST policy reads credentials too; do not retain a fill across an account switch.
        const current = yield* credentials.get("github.com").pipe(Effect.orElseSucceed(() => null));
        if (current?.fingerprint === credential.fingerprint) {
          if (signedUrls.size >= SIGNED_URL_CACHE_MAX_ENTRIES) {
            const oldest = signedUrls.keys().next().value;
            if (oldest !== undefined) signedUrls.delete(oldest);
          }
          signedUrls.set(cacheKey, { at: now, url: signed });
        }
      }
      return media;
    },
  );

  return GitHubMediaFetch.of({ fetch });
});

export const layer = Layer.effect(GitHubMediaFetch, make);

export const githubMediaResponse = Effect.fn("GitHubMediaFetch.githubMediaResponse")(function* (
  asset: GitHubMediaLocation & { readonly expiresAt: number },
  requestHeaders: Record<string, string | undefined>,
) {
  const service = yield* GitHubMediaFetch;
  const response = yield* service.fetch(asset, requestHeaders);
  const remainingSeconds = Math.floor((asset.expiresAt - (yield* Clock.currentTimeMillis)) / 1000);
  const headers: Record<string, string> = {
    "cache-control":
      remainingSeconds > 0 ? `private, max-age=${remainingSeconds}` : "private, no-store",
    "x-content-type-options": "nosniff",
  };
  if (response === null) return HttpServerResponse.empty({ status: 502, headers });
  // It carries none of the upstream entity headers: a `content-length` with no body behind it
  // holds the connection open until the browser gives up on it.
  if (response.status >= 400) {
    return HttpServerResponse.empty({
      status: response.status >= 500 ? 502 : response.status,
      headers,
    });
  }
  const upstreamType =
    response.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const contentType = MEDIA_CONTENT_TYPE_PATTERN.test(upstreamType)
    ? upstreamType
    : Option.getOrElse(Mime.getType(githubMediaFileName(asset.url)), () => "").toLowerCase();
  if (!MEDIA_CONTENT_TYPE_PATTERN.test(contentType)) {
    return HttpServerResponse.empty({ status: 415, headers });
  }
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = response.headers[name];
    if (value !== undefined) headers[name] = value;
  }
  headers["content-type"] = contentType;
  if (contentType === SVG_CONTENT_TYPE) {
    headers["content-security-policy"] = SVG_CONTENT_SECURITY_POLICY;
  }
  return HttpServerResponse.stream(response.stream, {
    status: response.status,
    headers,
    contentType,
  });
});
