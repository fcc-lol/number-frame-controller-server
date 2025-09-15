import express from "express";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import dotenv from "dotenv";
import cors from "cors";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { promises as fs } from "fs";
import path from "path";

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

// Helper function to ensure number is always a positive integer within 4-digit range
const enforceMaxDigits = (num) => {
  // Convert to positive integer first
  let intNum = Math.floor(Math.abs(num));

  // If it's 0, make it 1
  if (intNum === 0) {
    intNum = 1;
  }

  // If greater than 9999, take modulo 9999 and add 1 to ensure range 1-9999
  if (intNum > 9999) {
    intNum = (intNum % 9999) + 1;
  }

  return intNum;
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

// Define schema for Q&A pairs
const QAPairsResponse = z.object({
  qaPairs: z
    .array(
      z.object({
        question: z.string(),
        answer: z.number().transform(enforceMaxDigits)
      })
    )
    .length(25)
});

app.get("/update-suggested-questions-library", async (req, res) => {
  try {
    // Check API key authentication
    const providedApiKey = req.query.fccApiKey;
    const requiredApiKey = process.env.FCC_API_KEY;

    if (!requiredApiKey) {
      return res.status(500).json({
        error: "Server configuration error",
        message: "FCC_API_KEY not configured"
      });
    }

    if (!providedApiKey || providedApiKey !== requiredApiKey) {
      return res.status(401).json({
        error: "Unauthorized",
        message: "Valid API key required"
      });
    }

    const response = await openai.responses.parse({
      model: "gpt-4.1-nano",
      input: [
        {
          role: "system",
          content: `Generate exactly 25 esoteric and strange questions with their numerical answers. Include questions about history, nature, science, geography, art, and math. CRITICAL CONSTRAINT: Each answer MUST be between -9999 and 9999 (4 digits maximum). If the actual answer would be larger, provide a rounded, scaled, or modified version that fits within this range. For years, use the last 4 digits. For large quantities, use thousands or abbreviated forms. The current year is ${new Date().getFullYear()}. Return both the question and its numerical answer for each pair.`
        },
        {
          role: "user",
          content:
            "Generate 25 creative question and answer pairs where each answer is a number that fits within 4 digits (-9999 to 9999). Be inventive and think outside the box."
        }
      ],
      temperature: 0.9,
      text: {
        format: zodTextFormat(QAPairsResponse, "qa_pairs_response")
      }
    });

    const qaPairsResult = response.output_parsed;

    // Clean up questions and ensure answers are within constraints
    const cleanedQAPairs = qaPairsResult.qaPairs
      .map((pair) => ({
        question: pair.question
          .trim()
          .replace(/[,;]+$/, "") // Remove trailing commas or semicolons
          .replace(/\.+$/, "") // Remove trailing periods
          .trim(),
        answer: enforceMaxDigits(pair.answer)
      }))
      .filter((pair) => pair.question.length > 0); // Remove any pairs with empty questions

    // Ensure the data directory exists
    const dataDir = path.join(process.cwd(), "data");
    try {
      await fs.mkdir(dataDir, { recursive: true });
    } catch (err) {
      // Directory might already exist, ignore error
    }

    // Read existing questions if file exists
    const filepath = path.join(dataDir, "questions-answers.json");
    let existingQuestions = [];

    try {
      const existingData = await fs.readFile(filepath, "utf8");
      existingQuestions = JSON.parse(existingData);
    } catch (err) {
      // File doesn't exist or is invalid, start with empty array
      existingQuestions = [];
    }

    // Add new questions to existing array
    const allQuestions = [...existingQuestions, ...cleanedQAPairs];

    // Save updated array to file
    await fs.writeFile(filepath, JSON.stringify(allQuestions, null, 2), "utf8");

    res.json({
      success: true,
      message: "Questions and answers library updated successfully"
    });
  } catch (error) {
    console.error("Error updating suggested questions library:", error);
    res.status(500).json({
      error: "Failed to update suggested questions library",
      message: error.message
    });
  }
});

app.get("/get-suggested-questions", async (req, res) => {
  try {
    // Read questions from library
    const dataFilepath = path.join(
      process.cwd(),
      "data",
      "questions-answers.json"
    );

    try {
      const libraryData = await fs.readFile(dataFilepath, "utf8");
      const questionsLibrary = JSON.parse(libraryData);

      if (questionsLibrary.length === 0) {
        return res.status(404).json({
          error: "No questions available",
          message:
            "Library is empty. Use /update-suggested-questions-library to add questions first."
        });
      }

      // Select 25 random questions (or all if less than 25)
      const numberOfQuestions = Math.min(25, questionsLibrary.length);
      const shuffled = [...questionsLibrary].sort(() => Math.random() - 0.5);
      const randomQuestions = shuffled.slice(0, numberOfQuestions);

      // Extract just the questions (not the answers)
      const questions = randomQuestions.map((item) => item.question);

      res.json({
        success: true,
        questions: questions,
        count: questions.length
      });
    } catch (err) {
      return res.status(404).json({
        error: "Library not found",
        message:
          "Questions library not found. Use /update-suggested-questions-library to create it first."
      });
    }
  } catch (error) {
    console.error("Error getting suggested questions:", error);
    res.status(500).json({
      error: "Failed to get suggested questions",
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

    // First check if question exists in library
    let answerFromLibrary = null;
    const dataFilepath = path.join(
      process.cwd(),
      "data",
      "questions-answers.json"
    );

    try {
      const libraryData = await fs.readFile(dataFilepath, "utf8");
      const questionsLibrary = JSON.parse(libraryData);

      // Search for matching question (case insensitive, trimmed)
      const normalizedQuestion = question.trim().toLowerCase();
      const matchingEntry = questionsLibrary.find(
        (entry) => entry.question.trim().toLowerCase() === normalizedQuestion
      );

      if (matchingEntry) {
        answerFromLibrary = matchingEntry.answer;
      }
    } catch (err) {
      // Library file doesn't exist or is invalid, proceed with GPT
      console.log("Library file not found or invalid, proceeding with GPT");
    }

    let constrainedNumber;
    let answerSource;

    if (answerFromLibrary !== null) {
      // Use answer from library
      constrainedNumber = enforceMaxDigits(answerFromLibrary);
      answerSource = "library";
    } else {
      // Proceed with GPT as fallback
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
      constrainedNumber = enforceMaxDigits(numberResult.number);
      answerSource = "gpt";
    }

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
      number: constrainedNumber,
      answerSource: answerSource
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
