/**
 * Fetch the list of models from any OpenAI-compatible `/models` endpoint.
 * OpenRouter's endpoint is public; OpenAI's requires the Bearer token.
 */
export async function fetchModels(baseURL, apiKey) {
    const url = baseURL.replace(/\/$/, "") + "/models";
    const headers = { Accept: "application/json" };
    if (apiKey)
        headers.Authorization = `Bearer ${apiKey}`;
    const res = await fetch(url, { headers });
    if (!res.ok) {
        throw new Error(`GET ${url} → HTTP ${res.status} ${res.statusText}`);
    }
    const json = (await res.json());
    return json.data ?? [];
}
export function filterModels(models, query) {
    if (!query)
        return models;
    const q = query.toLowerCase();
    return models.filter((m) => m.id.toLowerCase().includes(q) ||
        (m.name?.toLowerCase().includes(q) ?? false));
}
