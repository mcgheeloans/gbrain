/**
 * LLM-powered query expansion using the same OAuth credentials as memory-lancedb-pro.
 * Reuses the openai-codex OAuth flow (free tier) — no additional API keys needed.
 *
 * Uses the Codex Responses API endpoint (not chat/completions) with SSE streaming,
 * matching the auth pattern from memory-lancedb-pro's llm-client.
 */

import { readFile, access } from "node:fs/promises";

const DEFAULT_OAUTH_PATH = "/home/mcgheeai/.openclaw/.memory-lancedb-pro/oauth.json";
const DEFAULT_MODEL = "gpt-5.4-mini";
const CODEX_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";

interface OAuthSession {
  access_token: string;
  refresh_token?: string;
  expires_at: number;
  provider: string;
  type: string;
  account_id?: string;
  // memory-lancedb-pro stores it differently — check
  accountId?: string;
}

let cachedToken: { token: string; accountId: string; expiresAt: number } | null = null;

async function loadSession(oauthPath?: string): Promise<{ token: string; accountId: string }> {
  const path = oauthPath ?? DEFAULT_OAUTH_PATH;

  // Use cached token if still valid (with 60s margin)
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return { token: cachedToken.token, accountId: cachedToken.accountId };
  }

  try { await access(path); } catch { throw new Error(`OAuth file not found: ${path}`); }

  const raw = await readFile(path, "utf-8");
  const session: OAuthSession = JSON.parse(raw);

  if (!session.access_token) throw new Error("No access_token in OAuth file");

  const accountId = session.account_id ?? session.accountId ?? "";
  cachedToken = { token: session.access_token, accountId, expiresAt: session.expires_at };
  return { token: session.access_token, accountId };
}

/**
 * Extract output text from Codex Responses SSE stream.
 */
function extractTextFromSse(body: string): string | null {
  let outputText = "";
  for (const line of body.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice(6).trim();
    if (payload === "[done]") break;
    try {
      const event = JSON.parse(payload);
      // Codex Responses API sends output_text.delta events
      if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
        outputText += event.delta;
      }
    } catch { /* skip malformed events */ }
  }
  return outputText || null;
}

export interface ExpansionOptions {
  maxVariants?: number;
  oauthPath?: string;
  model?: string;
  timeoutMs?: number;
}

/**
 * Expand a search query into semantically related variants using the
 * same gpt-5.4-mini OAuth that memory-lancedb-pro uses for smart extraction.
 *
 * Returns the original query plus up to `maxVariants` additional variants.
 * Falls back to [query] on any failure.
 */
export async function expandQueryWithLlm(
  query: string,
  opts?: ExpansionOptions,
): Promise<string[]> {
  const maxVariants = opts?.maxVariants ?? 3;
  const model = opts?.model ?? DEFAULT_MODEL;
  const timeoutMs = opts?.timeoutMs ?? 10_000;

  try {
    const { token, accountId } = await loadSession(opts?.oauthPath);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(CODEX_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        "OpenAI-Beta": "responses=experimental",
        ...(accountId ? { "chatgpt-account-id": accountId } : {}),
        originator: "codex_cli_rs",
      },
      body: JSON.stringify({
        model,
        instructions: `You are a search query expansion assistant. Given a user's search query, generate ${maxVariants} alternative phrasings that would find the same information. Return ONLY a JSON array of strings, no explanation. Example: ["variant1", "variant2", "variant3"]. Keep variants concise (under 10 words each).`,
        input: [
          {
            role: "user",
            content: [{ type: "input_text", text: query }],
          },
        ],
        store: false,
        stream: true,
        text: { format: { type: "text" } },
      }),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!response.ok) {
      return [query];
    }

    const body = await response.text();
    const content = extractTextFromSse(body);

    if (!content) return [query];

    // Extract JSON array from response
    const arrMatch = content.match(/\[[\s\S]*\]/);
    if (!arrMatch) return [query];

    const variants: string[] = JSON.parse(arrMatch[0]);

    // Prepend original, deduplicate, cap
    const all = [query, ...variants.filter((v): v is string => typeof v === "string" && v.trim().length > 0)];
    const unique = [...new Set(all.map(v => v.toLowerCase().trim()))];
    return unique.slice(0, maxVariants + 1);
  } catch (err) {
    console.error('[llm-expand] expansion failed:', err instanceof Error ? err.message : String(err));
    return [query];
  }
}
