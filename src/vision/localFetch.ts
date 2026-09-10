/** The studio ships its runtime and model assets locally; SDK telemetry has no network permission. */
export function makeLocalFetch(
  origin: string,
  nativeFetch: typeof fetch,
): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const target = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
      origin,
    );
    if (target.origin !== new URL(origin).origin)
      return Promise.reject(
        new TypeError(
          "Prism Stage vision workers only fetch same-origin assets.",
        ),
      );
    return nativeFetch(input, init);
  }) as typeof fetch;
}
