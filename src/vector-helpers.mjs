// src/vector-helpers.mjs
import dotenv from "dotenv";
import OpenAI from "openai";
import fs from "fs";
import os from "os";
import path from "path";
import fetch from "node-fetch";

// Cargar .env solo en local (en Railway no hace falta)
if (!process.env.RAILWAY_ENVIRONMENT) {
  dotenv.config();
}

const { OPENAI_API_KEY, VECTOR_STORE_ID } = process.env;

if (!OPENAI_API_KEY) {
  console.error("❌ Missing OPENAI_API_KEY in environment (vector-helpers)");
  throw new Error("Missing OPENAI_API_KEY");
}

if (!VECTOR_STORE_ID) {
  console.error("❌ Missing VECTOR_STORE_ID in environment (vector-helpers)");
  throw new Error("Missing VECTOR_STORE_ID");
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

export async function uploadTextToVectorStore(text) {
  const tmpDir = os.tmpdir();
  const tmpPath = path.join(
    tmpDir,
    `yen-movie-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`
  );

  await fs.promises.writeFile(tmpPath, text, "utf8");

  try {
    // 1) Subir archivo a OpenAI Files
    const file = await openai.files.create({
      file: fs.createReadStream(tmpPath),
      purpose: "assistants",
    });

    // 2) Adjuntar el file al Vector Store
    const resp = await fetch(
      `https://api.openai.com/v1/vector_stores/${VECTOR_STORE_ID}/files`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
          "OpenAI-Beta": "assistants=v2",
        },
        body: JSON.stringify({ file_id: file.id }),
      }
    );

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Vector store attach failed ${resp.status}: ${body}`);
    }

    const vsFile = await resp.json();
    console.log(
      "✅ Uploaded to vector store. file.id =",
      file.id,
      "vsFile.id =",
      vsFile.id
    );

    return { fileId: file.id };
  } catch (err) {
    console.error("❌ Error uploading to vector store:", err);
    throw err;
  } finally {
    fs.promises.unlink(tmpPath).catch(() => {});
  }
}
