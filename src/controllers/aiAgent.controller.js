import { google } from "@ai-sdk/google";
import { generateText } from "ai";
export async function AiProcessing(img, message) {
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

// 🎙️ Gemini Text-to-Speech
export async function textToAudio(text) {
  console.log("AI RESPONSE TEXT IS", text);
  try {
    const response = await googleAI.models.generateContent({
      model: "gemini-2.5-flash-preview-tts",
      contents: [{ parts: [{ text }] }],
      config: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: "Kore" },
          },
        },
      },
    });

    const data =
      response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (!data) throw new Error("No audio data returned from Gemini API.");

    const audioBuffer = Buffer.from(data, "base64");

    // Optional: Save for debugging
    if (process.env.DEBUG_SAVE_AUDIO === "true") {
      const fileName = `tts_output_${Date.now()}.wav`;
      await saveWaveFile(fileName, audioBuffer);
      console.log("TTS audio saved:", fileName);
    }

    return audioBuffer;
  } catch (error) {
    console.error("Error in textToAudio:", error);
    throw error;
  }
}
