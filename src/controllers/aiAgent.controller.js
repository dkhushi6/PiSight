import { google } from "@ai-sdk/google";
import { generateText } from "ai";
export async function ImageAiProcessing(img, message) {
  console.log("IMGE FROM THE CONTROLLER ", img ? img : "No image");
  const messages = [
    { role: "user", content: [{ type: "text", text: message }] },
  ];

  // Add image message if image exists
  if (img) {
    const base64 = Buffer.from(img).toString("base64");
    messages.push({
      role: "user",
      content: [
        { type: "text", text: "Describe this image in detail" },
        { type: "image", image: `data:image/png;base64,${base64}` },
      ],
    });
  }

  const response = await generateText({
    model: google("gemini-2.5-flash"),
    system:
      "You are an intelligent assistant. Answer like a human, keep it short, clear, consistent, and do not use markdown formatting.",
    messages: messages,
  });
  const resultText = response.steps
    .map((step) =>
      step.content.map((c) => (c.type === "text" ? c.text : "")).join("\n")
    )
    .join("\n");

  console.log("AI RESPONSE:", resultText);
  return resultText;
}
