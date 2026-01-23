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

module.exports = { streamGroq };