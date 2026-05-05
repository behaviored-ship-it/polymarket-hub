// Vercel serverless proxy for Gamma API
// Browsers can't call gamma-api.polymarket.com directly — CORS isn't enabled.
// This proxy forwards the query string and returns the JSON.
//
// Usage from frontend: GET /api/gamma?condition_ids=0x...
//                      GET /api/gamma?conditionId=0x...
//
// The query is forwarded as-is to https://gamma-api.polymarket.com/markets

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  // Pass-through every query param the client sent
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(req.query || {})) {
    if (v == null) continue;
    if (Array.isArray(v)) v.forEach((vv) => qs.append(k, vv));
    else qs.append(k, String(v));
  }
  const url = `https://gamma-api.polymarket.com/markets?${qs.toString()}`;

  try {
    const resp = await fetch(url);
    const text = await resp.text();
    res.status(resp.status);
    res.setHeader("Content-Type", "application/json");
    res.send(text);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
