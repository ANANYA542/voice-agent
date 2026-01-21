const Groq = require("groq-sdk");

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

async function callGroq(messages) {
  const start = Date.now();

  try {
    const completion = await groq.chat.completions.create({
      model: "llama-3.1-8b-instant",
      messages: messages,
      temperature: 0.3,
    });

    const latency = Date.now() - start;

    return {
      text: completion.choices[0].message.content,
      latency
    };
  } catch (err) {
    console.error("Groq API Error:", err.message);
    return {
      text: "I'm having trouble connecting to my brain right now. Please try again.",
      latency: Date.now() - start,
      error: true
    };
  }
}

module.exports = { callGroq };