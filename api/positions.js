export default async function handler(req, res) {
  const { wallet, offset = 0, type = "closed", sort = "ASC" } = req.query;

  if (!wallet || !wallet.startsWith("0x")) {
    return res.status(400).json({ error: "Invalid wallet address" });
  }

  const urls = {
    closed: `https://data-api.polymarket.com/closed-positions?user=${wallet}&sortBy=TIMESTAMP&sortDirection=${sort}&limit=50&offset=${offset}`,
    open:   `https://data-api.polymarket.com/positions?user=${wallet}&sizeThreshold=0.01`,
  };

  try {
    const response = await fetch(urls[type] || urls.closed);
    const data = await response.json();
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET");
    res.status(200).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}