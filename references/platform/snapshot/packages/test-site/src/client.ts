export interface PageResult {
  status: number;
  location?: string;
  /** The page's data-state marker (the deterministic state signal). */
  state?: string;
  failCount?: number;
  mfaAttempts?: number;
  text: string;
}

/**
 * A minimal cookie-aware HTTP client for the local test site. Redirects
 * are NOT followed automatically: the driver classifies each hop.
 */
export class SiteClient {
  #baseUrl: string;
  #cookie: string | undefined;
  #savedCookie: string | undefined;

  constructor(baseUrl: string) {
    this.#baseUrl = baseUrl;
  }

  get cookie(): string | undefined {
    return this.#cookie;
  }

  saveCookie(): void {
    this.#savedCookie = this.#cookie;
  }

  restoreSavedCookie(): void {
    this.#cookie = this.#savedCookie;
  }

  discardSavedCookie(): void {
    this.#savedCookie = undefined;
    this.#cookie = undefined;
  }

  async request(method: string, path: string, body?: Record<string, unknown>): Promise<PageResult> {
    const res = await fetch(`${this.#baseUrl}${path}`, {
      method,
      redirect: "manual",
      headers: {
        ...(body ? { "content-type": "application/json" } : {}),
        ...(this.#cookie ? { cookie: this.#cookie } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const setCookies = res.headers.getSetCookie();
    for (const sc of setCookies) {
      const pair = sc.split(";")[0] ?? "";
      if (pair.startsWith("ts_session=")) {
        const value = pair.slice("ts_session=".length);
        this.#cookie = value ? `ts_session=${value}` : undefined;
      }
    }
    const text = await res.text();
    const state = /data-state="([^"]+)"/.exec(text)?.[1];
    const failCount = /data-fail-count="(\d+)"/.exec(text)?.[1];
    const mfaAttempts = /data-mfa-attempts="(\d+)"/.exec(text)?.[1];
    return {
      status: res.status,
      location: res.headers.get("location") ?? undefined,
      state,
      ...(failCount ? { failCount: Number(failCount) } : {}),
      ...(mfaAttempts ? { mfaAttempts: Number(mfaAttempts) } : {}),
      text,
    };
  }

  get(path: string): Promise<PageResult> {
    return this.request("GET", path);
  }

  post(path: string, body?: Record<string, unknown>): Promise<PageResult> {
    return this.request("POST", path, body ?? {});
  }
}
