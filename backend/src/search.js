let fetch; 

async function searchWeb(query) {
  if (!fetch) {
      const mod = await import("node-fetch");
      fetch = mod.default;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 3000); 
  try {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.TAVILY_API_KEY}`
      },
      body: JSON.stringify({
        query: query,
        search_depth: "basic",
        include_answer: true
      }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);
    const data = await res.json();
    return data.answer || "";
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error("Search timed out (>3000ms)"); 
    }
    throw error;
  }
}

function needsSearch(text) {
  
  const keywords = [
      "weather", "today", "latest", "news", "price", "score", 
      "who won", "current", "now", "population", "capital", 
      "president", "temperature", "time", "date", "update"
  ];
  return keywords.some(k => text.toLowerCase().includes(k));
}

module.exports = { searchWeb, needsSearch };