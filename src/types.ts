export interface Env {
  LINKS: KVNamespace;
  DB: D1Database;
  BASE_URL: string;
  DEFAULT_FALLBACK_URL?: string;
  ADMIN_PASSWORD?: string;
}

/** Value stored in KV under the slug. Kept small: it is read on every redirect. */
export interface LinkRecord {
  url: string;
  /** Expiry, epoch ms. */
  exp?: number;
  /** Click cap (non-bot clicks). */
  max?: number;
  /** Fallback URL once expired or capped. */
  fb?: string;
  /** Set once the cap has been reached. */
  done?: true;
}
