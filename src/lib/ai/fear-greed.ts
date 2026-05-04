let cached: { value: number; label: string; fetchedAt: number } | null = null;
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

export async function getFearGreedIndex(): Promise<{ value: number; label: string }> {
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) {
    return { value: cached.value, label: cached.label };
  }

  try {
    const resp = await fetch("https://api.alternative.me/fng/?limit=1", {
      signal: AbortSignal.timeout(5000),
    });
    const json = await resp.json();
    const data = json?.data?.[0];
    if (data) {
      cached = {
        value: Number(data.value),
        label: data.value_classification,
        fetchedAt: Date.now(),
      };
      return { value: cached.value, label: cached.label };
    }
  } catch { /* fallback */ }

  return { value: 50, label: "Neutral" };
}
