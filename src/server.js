import express from "express";
import { createServer } from "http";
import dotenv from "dotenv";
import { Server } from "socket.io";
import { AssemblyAI } from "assemblyai";
import { GoogleGenAI } from "@google/genai";
import wav from "wav";

import { AiProcessing } from "./controllers/aiAgent.controller.js";

dotenv.config();

const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
  maxHttpBufferSize: 10e6, // 10MB for large images
});

const PORT = process.env.PORT || 5000;

// AssemblyAI client
const assemblyClient = new AssemblyAI({
  apiKey: process.env.STT_API_KEY,
});

// Google AI client
const googleAI = new GoogleGenAI({
  apiKey: process.env.GOOGLE_API_KEY,
});

// 🧠 TTS Helper Functions
async function saveWaveFile(filename, pcmData, channels = 1, rate = 24000, sampleWidth = 2) {
  return new Promise((resolve, reject) => {
    const writer = new wav.FileWriter(filename, {
      channels,
      sampleRate: rate,
      bitDepth: sampleWidth * 8,
    });

    writer.on("finish", resolve);
    writer.on("error", reject);

    writer.write(pcmData);
    writer.end();
  });
}

// 🎙️ Gemini Text-to-Speech
async function textToAudio(text) {
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

    const data = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (!data) throw new Error("No audio data returned from Gemini API.");

    const audioBuffer = Buffer.from(data, "base64");

    // Optional: Save for debugging (disable in production)
    if (process.env.DEBUG_SAVE_AUDIO === "true") {
      const fileName = `tts_output_${Date.now()}.wav`;
      await saveWaveFile(fileName, audioBuffer);
      console.log("TTS audio saved:", fileName);
    }

    return audioBuffer;
  } catch (error) {
    console.error("Error in textToAudio:", error);
    throw error; // Propagate error for better handling
  }
}

// ----------------------------
// 🔊 Main Server Logic
// ----------------------------
app.get("/", (req, res) => {
  res.json({ 
    status: "online", 
    service: "PISIGHT Backend",
    timestamp: new Date().toISOString()
  });
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({ 
    status: "healthy",
    connections: io.engine.clientsCount 
  });
});

io.on("connection", async (socket) => {
  console.log(`[${new Date().toISOString()}] Device connected: ${socket.id}`);

  // Store session-specific data
  const sessionData = {
    image: null,
    imageChunks: [],
    transcriber: null,
    isProcessing: false,
  };

  // Initialize STT transcriber
  const CONNECTION_PARAMS = {
    sampleRate: 16000,
    formatTurns: true,
  };

  try {
    sessionData.transcriber = assemblyClient.streaming.transcriber(CONNECTION_PARAMS);

    sessionData.transcriber.on("open", ({ id }) => {
      console.log(`[${socket.id}] STT session opened: ${id}`);
      socket.emit("stt_ready", { sessionId: id });
    });

    sessionData.transcriber.on("error", (error) => {
      console.error(`[${socket.id}] STT Error:`, error);
      socket.emit("error", { type: "stt", message: error.message });
    });

    sessionData.transcriber.on("close", (code, reason) => {
      console.log(`[${socket.id}] STT session closed:`, code, reason);
    });

    // Handle transcription turns
    sessionData.transcriber.on("turn", async (turn) => {
      if (!turn.transcript || sessionData.isProcessing) return;
      
      console.log(`[${socket.id}] Transcribed:`, turn.transcript);
      sessionData.isProcessing = true;

      try {
        // Process with AI (vision + text)
        const aiResponseText = await AiProcessing(
          sessionData.image, 
          turn.transcript
        );
        console.log(`[${socket.id}] AI Response:`, aiResponseText);

        // Convert to audio
        const aiAudioBuffer = await textToAudio(aiResponseText);

        // Send both text and audio to client
        socket.emit("ai_response", {
          text: aiResponseText,
          audio: aiAudioBuffer,
          timestamp: Date.now(),
        });

      } catch (err) {
        console.error(`[${socket.id}] Error in AI processing:`, err);
        socket.emit("error", { 
          type: "ai_processing", 
          message: "Failed to process your request" 
        });
      } finally {
        sessionData.isProcessing = false;
      }
    });

    await sessionData.transcriber.connect();

  } catch (err) {
    console.error(`[${socket.id}] Failed to initialize STT:`, err);
    socket.emit("error", { type: "initialization", message: err.message });
  }

  // 🎤 Handle audio streaming
  socket.on("audio_chunk", (chunk) => {
    if (sessionData.transcriber && sessionData.transcriber.stream()) {
      try {
        sessionData.transcriber.stream().writer.write(Buffer.from(chunk));
      } catch (err) {
        console.error(`[${socket.id}] Error writing audio chunk:`, err);
      }
    }
  });

  // 🎤 Audio stream control
  socket.on("audio_start", () => {
    console.log(`[${socket.id}] Audio stream started`);
    sessionData.isProcessing = false;
  });

  socket.on("audio_end", () => {
    console.log(`[${socket.id}] Audio stream ended`);
  });

  // 📸 Handle image upload
  socket.on("image_chunk", async (data) => {
    try {
      const bufferChunk = Buffer.from(data.chunk);
      sessionData.imageChunks.push(bufferChunk);

      if (data.isLast) {
        const fullBuffer = Buffer.concat(sessionData.imageChunks);
        sessionData.image = fullBuffer;
        
        console.log(`[${socket.id}] Image received: ${fullBuffer.length} bytes`);
        
        socket.emit("image_received", { 
          size: fullBuffer.length,
          timestamp: Date.now() 
        });
        
        // Clear chunks
        sessionData.imageChunks = [];
      }
    } catch (err) {
      console.error(`[${socket.id}] Error processing image:`, err);
      socket.emit("error", { type: "image_upload", message: err.message });
    }
  });

  // 💬 Handle direct text messages
  socket.on("text_message", async (message) => {
    if (sessionData.isProcessing) {
      socket.emit("error", { 
        type: "busy", 
        message: "Still processing previous request" 
      });
      return;
    }

    console.log(`[${socket.id}] Text received:`, message);
    sessionData.isProcessing = true;

    try {
      const aiResponseText = await AiProcessing(sessionData.image, message);
      console.log(`[${socket.id}] AI Response:`, aiResponseText);

      const aiAudioBuffer = await textToAudio(aiResponseText);

      socket.emit("ai_response", {
        text: aiResponseText,
        audio: aiAudioBuffer,
        timestamp: Date.now(),
      });

    } catch (err) {
      console.error(`[${socket.id}] Error processing text:`, err);
      socket.emit("error", { 
        type: "text_processing", 
        message: "Failed to process your message" 
      });
    } finally {
      sessionData.isProcessing = false;
    }
  });

  // 🧹 Clear image from session
  socket.on("clear_image", () => {
    sessionData.image = null;
    console.log(`[${socket.id}] Image cleared`);
    socket.emit("image_cleared");
  });

  // 🔌 Handle disconnection
  socket.on("disconnect", async () => {
    console.log(`[${socket.id}] Device disconnected`);
    
    if (sessionData.transcriber) {
      try {
        await sessionData.transcriber.close();
      } catch (err) {
        console.error(`[${socket.id}] Error closing transcriber:`, err);
      }
    }

    // Clear session data
    sessionData.image = null;
    sessionData.imageChunks = [];
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error("Express error:", err);
  res.status(500).json({ error: "Internal server error" });
});

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("SIGTERM received, closing server...");
  server.close(() => {
    console.log("Server closed");
    process.exit(0);
  });
});

server.listen(PORT, () => {
  console.log(`🚀 PISIGHT Backend running on port ${PORT}`);
  console.log(`📡 Socket.IO ready for connections`);
});