import express from "express";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import dotenv from "dotenv";
import cors from "cors";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";

// Load environment variables from .env file
dotenv.config();

const app = express();
const port = 3116;

// Shared CORS configuration
const allowedOrigins = ["http://localhost:3000", "https://8888.fcc.lol"];
const corsOriginHandler = (origin, callback) => {
  // Allow specific domains only
  if (!origin || allowedOrigins.includes(origin)) {
    callback(null, true);
  } else {
    callback(new Error("Not allowed by CORS"));
  }
};

// Create HTTP server and WebSocket server
const server = createServer(app);
const wss = new WebSocketServer({ server });

// Express CORS configuration
const corsOptions = {
  origin: corsOriginHandler,
  credentials: true,
  optionsSuccessStatus: 200
};

// Middleware
app.use(cors(corsOptions));
app.use(express.json());

// Initialize OpenAI
const openai = new OpenAI();

// Helper function to ensure number is within 4-digit limit
const enforceMaxDigits = (num) => {
  const absNum = Math.abs(num);
  if (absNum > 9999) {
    // For numbers > 9999, take modulo 10000 to keep within 4 digits
    return num < 0 ? -(absNum % 10000) : absNum % 10000;
  }
  return num;
};

// Define schema for number extraction with 4-digit constraint
const NumberResponse = z.object({
  number: z
    .number()
    .refine((val) => Math.abs(val) <= 9999, {
      message: "Number must be 4 digits or less"
    })
    .transform(enforceMaxDigits)
});

// Define schema for suggested questions
const QuestionsResponse = z.object({
  questions: z.array(z.string()).length(25)
});

app.get("/get-suggested-questions", async (req, res) => {
  try {
    const response = await openai.responses.parse({
      model: "gpt-4.1-nano",
      input: [
        {
          role: "system",
          content: `Generate exactly 25 esoteric and strange questions that can be answered with a specific number. Include questions about history, nature, science, geography, art, and math. VERY IMPORTANT: Each question should have a clear numerical answer that is ALWAYS less than 4 digits. NEVER use more than 4 digits in the answer since we cannot show more than 4 digits in the display we are using to show the answer. The current year is ${new Date().getFullYear()}.`
        },
        {
          role: "user",
          content:
            "Generate 25 questions that can be answered with numbers that are less than 4 digits. Be creative and think outside the box."
        }
      ],
      temperature: 0.9,
      text: {
        format: zodTextFormat(QuestionsResponse, "questions_response")
      }
    });

    const questionsResult = response.output_parsed;

    // Clean up questions by removing trailing punctuation and whitespace
    const cleanedQuestions = questionsResult.questions
      .map((question) =>
        question
          .trim()
          .replace(/[,;]+$/, "") // Remove trailing commas or semicolons
          .replace(/\.+$/, "") // Remove trailing periods
          .trim()
      )
      .filter((q) => q.length > 0); // Remove any empty questions

    res.json({
      success: true,
      questions: cleanedQuestions,
      count: cleanedQuestions.length
    });
  } catch (error) {
    console.error("Error generating suggested questions:", error);
    res.status(500).json({
      error: "Failed to generate suggested questions",
      message: error.message
    });
  }
});

app.post("/process-question", async (req, res) => {
  try {
    const { question } = req.body;

    if (!question) {
      return res.status(400).json({ error: "Question is required" });
    }

    const response = await openai.responses.parse({
      model: "gpt-4.1-nano",
      input: [
        {
          role: "system",
          content: `Respond with a number that is an answer to the question. CRITICAL CONSTRAINT: The number MUST be between -9999 and 9999 (4 digits maximum). If the actual answer would be larger, provide a rounded, scaled, or modified version that fits within this range. For years, use the last 4 digits. For large quantities, use thousands or abbreviated forms. The current year is ${new Date().getFullYear()}. `
        },
        {
          role: "user",
          content: question
        }
      ],
      text: {
        format: zodTextFormat(NumberResponse, "number_response")
      }
    });

    const numberResult = response.output_parsed;

    // Apply additional constraint enforcement as backup
    const constrainedNumber = enforceMaxDigits(numberResult.number);

    // Broadcast to all connected WebSocket clients
    const message = JSON.stringify({
      type: "number-update",
      number: constrainedNumber
    });
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });

    res.json({
      success: true,
      number: constrainedNumber
    });
  } catch (error) {
    console.error("Error processing question:", error);
    res.status(500).json({
      error: "Failed to process question",
      message: error.message
    });
  }
});

// WebSocket connection handling
wss.on("connection", (ws, request) => {
  console.log("Client connected from:", request.socket.remoteAddress);

  ws.on("close", () => {
    console.log("Client disconnected from:", request.socket.remoteAddress);
  });

  ws.on("error", (error) => {
    console.error("WebSocket error:", error);
  });
});

server.listen(port, () => {
  console.log(`Server is running at http://localhost:${port}`);
});
