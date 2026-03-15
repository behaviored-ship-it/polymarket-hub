export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  const apiKey = process.env.heisenberg;
  if (!apiKey) return res.status(500).json({ error: "Heisenberg API key not configured" });

  const { agent, ...params } = req.query;
  if (!agent) return res.status(400).json({ error: "Missing agent parameter" });

  const BASE_URL = "https://narrative.agent.heisenberg.so/api/v2/semantic/retrieve/parameterized";

  try {
    const response = await fetch(BASE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        agent_id: parseInt(agent),
        params: params,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      return res.status(response.status).json({ error: errText });
    }

    const data = await response.json();
    res.status(200).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
