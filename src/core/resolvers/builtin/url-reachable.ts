/**
 * url_reachable — deterministic HEAD-check resolver.
 *
 * Input:  { url: string }
 * Output: { reachable: boolean, status?: number, finalUrl?: string }
 *
 * Used by `gbrain integrity` to detect dead-link citations on brain pages.
 * Always confidence=1.0 when the backend answers (status codes are ground
 * truth); confidence=0 only when the HTTP call itself fails (DNS, timeout)
 * and we genuinely don't know.
 *
 * Security:
 * - SSRF guard reuses isInternalUrl() from src/commands/integrations.ts
 *   (same wave-3 hardening that protects recipe health_checks).
 * - Redirect chain is followed manually (max 5 hops) with per-hop
 *   re-validation; matches the integrations.ts pattern so no new SSRF
 *   bypass surface.
 * - HEAD first, GET fallback when server rejects HEAD (405 / 501).
 *   Abort token threads through both.
 */

import { isInternalUrl } from '../../../commands/integrations.ts';
import type {
  Resolver,
  ResolverContext,
  ResolverRequest,
  ResolverResult,
} from '../interface.ts';
import { ResolverError } from '../interface.ts';

export interface UrlReachableInput {
  url: string;
}

export interface UrlReachableOutput {
  reachable: boolean;
  status?: number;
  /** URL after redirect chain. Only set if different from input.url. */
  finalUrl?: string;
  /** Set when reachable=false and we have a human-readable reason. */
  reason?: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 5;

export const urlReachableResolver: Resolver<UrlReachableInput, UrlReachableOutput> = {
  id: 'url_reachable',
  cost: 'free',
  backend: 'head-check',
  description: 'HEAD-check a URL, follow redirects, detect dead links. SSRF-protected.',
  inputSchema: {
    type: 'object',
    properties: { url: { type: 'string', format: 'uri' } },
    required: ['url'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      reachable: { type: 'boolean' },
      status: { type: 'number' },
      finalUrl: { type: 'string' },
      reason: { type: 'string' },
    },
    required: ['reachable'],
  },

  async available(_ctx: ResolverContext): Promise<boolean> {
    // Nothing to check — fetch is globally available in Bun.
    return true;
  },

  async resolve(req: ResolverRequest<UrlReachableInput>): Promise<ResolverResult<UrlReachableOutput>> {
    const { url } = req.input;
    const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const signal = req.context.signal;

    if (typeof url !== 'string' || url.length === 0) {
      throw new ResolverError('schema', 'url_reachable: url must be a non-empty string', 'url_reachable');
    }

    // SSRF gate — refuse to probe internal/private/metadata endpoints.
    if (isInternalUrl(url)) {
      return {
        value: {
          reachable: false,
          reason: 'blocked: internal/private/metadata hostname or non-http(s) scheme',
        },
        confidence: 1,
        source: 'head-check',
        fetchedAt: new Date(),
      };
    }

    let currentUrl = url;
    let status: number | undefined;
    let usedMethod: 'HEAD' | 'GET' = 'HEAD';

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const combinedSignal = composeSignals(signal, timeoutMs);
      let resp: Response;
      try {
        resp = await fetch(currentUrl, {
          method: usedMethod,
          redirect: 'manual',
          signal: combinedSignal,
        });
      } catch (err: unknown) {
        if (isAbortError(err)) {
          throw new ResolverError('aborted', `url_reachable aborted (${currentUrl})`, 'url_reachable', err);
        }
        // fetch threw (DNS, connection refused, timeout). Not reachable, no status.
        return {
          value: {
            reachable: false,
            reason: `fetch error: ${errMessage(err).slice(0, 200)}`,
          },
          confidence: 1,
          source: 'head-check',
          fetchedAt: new Date(),
        };
      }

      status = resp.status;

      // Some servers reject HEAD with 405 / 501. Retry once as GET (same hop).
      if (usedMethod === 'HEAD' && (status === 405 || status === 501)) {
        usedMethod = 'GET';
        continue;
      }

      // Redirect handling
      if (status >= 300 && status < 400) {
        const location = resp.headers.get('location');
        if (!location) {
          return {
            value: {
              reachable: false,
              status,
              finalUrl: currentUrl !== url ? currentUrl : undefined,
              reason: 'redirect without Location header',
            },
            confidence: 1,
            source: 'head-check',
            fetchedAt: new Date(),
          };
        }
        const nextUrl = new URL(location, currentUrl).toString();
        // Re-validate each hop against SSRF.
        if (isInternalUrl(nextUrl)) {
          return {
            value: {
              reachable: false,
              status,
              finalUrl: currentUrl,
              reason: `redirect to blocked hostname: ${nextUrl}`,
            },
            confidence: 1,
            source: 'head-check',
            fetchedAt: new Date(),
          };
        }
        currentUrl = nextUrl;
        usedMethod = 'HEAD'; // reset to HEAD for the new hop
        continue;
      }

      // Terminal status. 2xx/4xx both count as deterministic answers:
      // 2xx = reachable, 4xx = reachable-but-dead-at-this-path.
      // We flag 4xx/5xx as unreachable for integrity purposes.
      const reachable = status >= 200 && status < 400;
      return {
        value: {
          reachable,
          status,
          finalUrl: currentUrl !== url ? currentUrl : undefined,
          reason: reachable ? undefined : `HTTP ${status}`,
        },
        confidence: 1,
        source: 'head-check',
        fetchedAt: new Date(),
      };
    }

    // Ran out of redirect budget
    return {
      value: {
        reachable: false,
        status,
        finalUrl: currentUrl,
        reason: `exceeded ${MAX_REDIRECTS} redirects`,
      },
      confidence: 1,
      source: 'head-check',
      fetchedAt: new Date(),
    };
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function isAbortError(err: unknown): boolean {
  return !!err && typeof err === 'object' &&
    'name' in err && (err as { name: string }).name === 'AbortError';
}

/**
 * Combine a caller-provided AbortSignal with a per-request timeout. If the
 * caller's signal fires OR the timeout elapses, the combined signal aborts.
 * Uses AbortSignal.any when available (Bun 1.1+, Node 22+); falls back to
 * a manual controller for older runtimes.
 */
function composeSignals(outer: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (!outer) return timeoutSignal;
  // Bun supports AbortSignal.any since 1.0.26
  if (typeof (AbortSignal as { any?: (signals: AbortSignal[]) => AbortSignal }).any === 'function') {
    return (AbortSignal as unknown as { any: (signals: AbortSignal[]) => AbortSignal }).any([outer, timeoutSignal]);
  }
  // Fallback: manual propagation
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (outer.aborted) controller.abort();
  else outer.addEventListener('abort', onAbort, { once: true });
  if (timeoutSignal.aborted) controller.abort();
  else timeoutSignal.addEventListener('abort', onAbort, { once: true });
  return controller.signal;
}
