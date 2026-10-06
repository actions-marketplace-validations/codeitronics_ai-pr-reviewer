// Chat completion over fetch for DeepSeek (default), Anthropic, OpenAI and Gemini. No SDKs, so the bundled
// GitHub Action stays small.

export type Provider = "deepseek" | "anthropic" | "openai" | "gemini";
export interface AI {
  provider: Provider;
  key: string;
  model: string;
}

export const PROVIDERS: Record<Provider, { env: string; model: string }> = {
  deepseek: { env: "DEEPSEEK_API_KEY", model: "deepseek-chat" },
  anthropic: { env: "ANTHROPIC_API_KEY", model: "claude-sonnet-5-5" },
  openai: { env: "OPENAI_API_KEY", model: "gpt-5-mini" },
  gemini: { env: "GEMINI_API_KEY", model: "gemini-2.5-flash" },
};

export const isProvider = (p: string): p is Provider => p in PROVIDERS;

/** Explicit provider/key if given, otherwise the first provider with a key in env (DeepSeek first). */
export function resolveAI(opts: { provider?: string; key?: string; model?: string } = {}, env: NodeJS.ProcessEnv = process.env): AI | null {
  const wanted = opts.provider || env.AI_PROVIDER;
  if (wanted) {
    if (!isProvider(wanted)) throw new Error(`Unknown provider "${wanted}". Use one of: ${Object.keys(PROVIDERS).join(", ")}.`);
    const key = opts.key || env[PROVIDERS[wanted].env];
    if (!key) throw new Error(`No API key for ${wanted}: pass api_key or set ${PROVIDERS[wanted].env}.`);
    return { provider: wanted, key, model: opts.model || env.AI_MODEL || PROVIDERS[wanted].model };
  }
  for (const p of Object.keys(PROVIDERS) as Provider[]) {
    const key = env[PROVIDERS[p].env];
    if (key) return { provider: p, key, model: opts.model || env.AI_MODEL || PROVIDERS[p].model };
  }
  return null;
}

export async function completeJSON(ai: AI, system: string, user: string, { fetchImpl = fetch, maxTokens = 6000 } = {}): Promise<unknown> {
  let url: string;
  let headers: Record<string, string>;
  let body: unknown;
  let pick: (d: any) => string | undefined;
  if (ai.provider === "anthropic") {
    url = "https://api.anthropic.com/v1/messages";
    headers = { "x-api-key": ai.key, "anthropic-version": "2023-06-01" };
    body = { model: ai.model, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] };
    pick = (d) => d.content?.filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
  } else if (ai.provider === "gemini") {
    url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(ai.model)}:generateContent`;
    headers = { "x-goog-api-key": ai.key };
    body = { systemInstruction: { parts: [{ text: system }] }, contents: [{ role: "user", parts: [{ text: user }] }], generationConfig: { maxOutputTokens: maxTokens, responseMimeType: "application/json" } };
    pick = (d) => d.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join("");
  } else {
    url = ai.provider === "deepseek" ? "https://api.deepseek.com/chat/completions" : "https://api.openai.com/v1/chat/completions";
    headers = { authorization: `Bearer ${ai.key}` };
    body = {
      model: ai.model,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      response_format: { type: "json_object" },
      ...(ai.provider === "deepseek" ? { max_tokens: maxTokens } : { max_completion_tokens: maxTokens }),
    };
    pick = (d) => d.choices?.[0]?.message?.content;
  }
  const res = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${ai.provider} returned ${res.status}: ${data?.error?.message ?? JSON.stringify(data).slice(0, 300)}`);
  const text = pick(data);
  if (!text) throw new Error(`${ai.provider} returned no text.`);
  return parseJSON(text);
}

/** Accepts bare JSON, fenced JSON, or JSON with chatter around it. */
export function parseJSON(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = (fenced ? fenced[1] : text).trim();
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.search(/[[{]/);
    const end = Math.max(candidate.lastIndexOf("}"), candidate.lastIndexOf("]"));
    if (start >= 0 && end > start) return JSON.parse(candidate.slice(start, end + 1));
    throw new Error("The model's reply wasn't valid JSON.");
  }
}
