/**
 * Jina v5 embeddings API wrapper for C-lite.
 *
 * Uses jina-embeddings-v5-text-small (1024 dims, normalized).
 * Supports retrieval.passage for indexing and retrieval.query for search queries.
 * All-in-one API key read from JINA_API_KEY env.
 */

const JINA_API_KEY = process.env.JINA_API_KEY;
const JINA_BASE_URL = 'https://api.jina.ai/v1';
const MODEL = 'jina-embeddings-v5-text-small';
const DIMENSIONS = 1024;
const MAX_CHARS = 8000;

export interface EmbedderConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  dimensions?: number;
}

export class JinaEmbedder {
  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private dimensions: number;

  constructor(config: EmbedderConfig = {}) {
    this.apiKey = config.apiKey ?? JINA_API_KEY ?? '';
    this.baseUrl = config.baseUrl ?? JINA_BASE_URL;
    this.model = config.model ?? MODEL;
    this.dimensions = config.dimensions ?? DIMENSIONS;

    if (!this.apiKey) {
      throw new Error('JinaEmbedder: JINA_API_KEY is not set in environment');
    }
  }

  /**
   * Embed a batch of texts as passage/indexing content.
   * Truncates each text at MAX_CHARS.
   * task=retrieval.passage
   */
  async embed(texts: string[]): Promise<number[][]> {
    const truncated = texts.map((t) => t.slice(0, MAX_CHARS));
    return this.doEmbed(truncated, 'retrieval.passage');
  }

  /**
   * Embed a search query.
   * task=retrieval.query
   */
  async embedQuery(text: string): Promise<number[]> {
    const results = await this.doEmbed([text.slice(0, MAX_CHARS)], 'retrieval.query');
    return results[0];
  }

  private async doEmbed(texts: string[], task: string): Promise<number[][]> {
    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        task,
        dimensions: this.dimensions,
        normalize: true,
        input: texts,
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(
        `JinaEmbedder: embedding request failed (${response.status}): ${body}`,
      );
    }

    const json = await response.json() as {
      data?: Array<{ embedding: number[] }>;
      error?: string;
    };

    if (json.error) {
      throw new Error(`JinaEmbedder: API error: ${json.error}`);
    }

    if (!json.data || json.data.length !== texts.length) {
      throw new Error(
        `JinaEmbedder: expected ${texts.length} embeddings, got ${json.data?.length ?? 0}`,
      );
    }

    return json.data.map((item) => item.embedding);
  }
}
