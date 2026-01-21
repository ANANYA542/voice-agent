import { callGroq } from "./src/llm/groq.js";
import "dotenv/config";

async function run() {
  const messages = [
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: "Say hello in one sentence." },
  ];

  const res = await callGroq(messages);
  console.log(res);
}

run();