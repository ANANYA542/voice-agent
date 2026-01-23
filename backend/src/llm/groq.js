const Groq = require("groq-sdk");

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

// Returns an Async Iterator of tokens
async function* streamGroq(messages) {
  const start = Date.now();
  let firstToken = true;

  try {
    const stream = await groq.chat.completions.create({
      model: "llama-3.1-8b-instant",
      messages: messages,
      temperature: 0.3,
      stream: true, // Enable streaming
    });

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content || "";
      if (content) {
        if (firstToken) {
           console.log(`[LLM] First token after ${Date.now() - start}ms`);
           firstToken = false;
        }
        yield content;
      }
    }
  } catch (err) {
    console.error("Groq Stream Error:", err.message);
    yield " I am having trouble thinking right now.";
  }
}

// Check if query needs search
async function classifyIntent(query) {
    try {
        const completion = await groq.chat.completions.create({
            model: "llama-3.1-8b-instant",
            messages: [
                { role: "system", content: "You are a classifier. Does this user query require real-time external data (news, weather, sports, prices, 'who is', etc) that is not in your training data? Reply strictly 'true' or 'false'." },
                { role: "user", content: query }
            ],
            temperature: 0,
            max_tokens: 5
        });
        const res = completion.choices[0]?.message?.content?.toLowerCase().trim();
        return res === "true";
    } catch(e) {
        console.error("Intent Classification Failed:", e);
        return false; // Fail safe to no search
    }
}

module.exports = { streamGroq, classifyIntent };