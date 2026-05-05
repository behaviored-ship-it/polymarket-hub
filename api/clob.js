// Vercel serverless proxy for CLOB API
// Direct browser calls to clob.polymarket.com/book usually work, but this is a
// fallback in case CORS changes — same pattern as api/positions.js + api/gamma.js.
//
// Usage from frontend: GET /api/clob?token_id=0x...

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const tokenId = req.query?.token_id;
  if (!tokenId) return res.status(400).json({ error: "Missing token_id" });

  const url = `https://clob.polymarket.com/book?token_id=${encodeURIComponent(tokenId)}`;
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
