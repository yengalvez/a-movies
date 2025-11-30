// src/server.mjs
import express from "express";
import dotenv from "dotenv";
import OpenAI from "openai";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import fetch from "node-fetch";
import { runYenMoviesAgent } from "./yen-agent.mjs";

// Cargar .env SOLO si estamos en local (en Railway no hace falta)
if (!process.env.RAILWAY_ENVIRONMENT) {
  dotenv.config();
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- DEBUG: ver qué hay de OpenAI en el entorno ---
console.log(
  "DEBUG OPENAI VARS:",
  Object.keys(process.env).filter((k) => k.includes("OPENAI"))
);
console.log("DEBUG has OPENAI_API_KEY?", !!process.env.OPENAI_API_KEY);

const {
  OPENAI_API_KEY,
  VECTOR_STORE_ID,
  TRAKT_CLIENT_ID,
  TRAKT_ACCESS_TOKEN,
  PORT,
} = process.env;

if (!OPENAI_API_KEY) {
  console.error("❌ Missing OPENAI_API_KEY in environment");
  process.exit(1);
}

if (!VECTOR_STORE_ID) {
  console.error("❌ Missing VECTOR_STORE_ID in environment");
  process.exit(1);
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

const app = express();
app.use(express.json());

// ---------- Helpers: Vector Store ----------------------------------------

function buildMovieDocument(movie) {
  const now = new Date().toISOString();
  return (
    JSON.stringify({
      type: movie.type || "movie_seen",
      title: movie.title,
      year: movie.year ?? null,
      trakt_id: movie.trakt_id ?? null,
      imdb: movie.imdb ?? null,
      slug: movie.slug ?? null,
      tmdb: movie.tmdb ?? null,
      rating: movie.rating ?? null,
      liked: movie.liked ?? null,
      state: movie.state ?? "seen",
      source: movie.source ?? "manual",
      marked_at: now,
      tags: movie.tags ?? [],
      comment: movie.comment ?? null,
    }) + "\n"
  );
}

async function uploadTextToVectorStore(text) {
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

    // 2) Adjuntar el file al Vector Store usando la API HTTP directa
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

// ---------- Helpers: Trakt -----------------------------------------------

function ensureTraktConfigured() {
  if (!TRAKT_CLIENT_ID || !TRAKT_ACCESS_TOKEN) {
    throw new Error(
      "TRAKT_CLIENT_ID or TRAKT_ACCESS_TOKEN not configured. Check your .env"
    );
  }
}

async function traktFetchHistory(limit = 200) {
  ensureTraktConfigured();
  const safeLimit = Math.max(1, Math.min(Number(limit) || 200, 500));

  const url = `https://api.trakt.tv/sync/history/movies?limit=${safeLimit}`;

  const resp = await fetch(url, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "trakt-api-version": "2",
      "trakt-api-key": TRAKT_CLIENT_ID,
      Authorization: `Bearer ${TRAKT_ACCESS_TOKEN}`,
    },
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Trakt history error ${resp.status}: ${body}`);
  }

  return resp.json();
}

async function traktAddToHistory(ids) {
  ensureTraktConfigured();

  const body = {
    movies: [
      {
        ids: {
          ...(ids.trakt_id ? { trakt: ids.trakt_id } : {}),
          ...(ids.imdb ? { imdb: ids.imdb } : {}),
          ...(ids.slug ? { slug: ids.slug } : {}),
          ...(ids.tmdb ? { tmdb: ids.tmdb } : {}),
        },
      },
    ],
  };

  if (Object.keys(body.movies[0].ids).length === 0) {
    throw new Error(
      "No valid ids provided for Trakt history (need trakt_id, imdb, slug or tmdb)"
    );
  }

  const resp = await fetch("https://api.trakt.tv/sync/history", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "trakt-api-version": "2",
      "trakt-api-key": TRAKT_CLIENT_ID,
      Authorization: `Bearer ${TRAKT_ACCESS_TOKEN}`,
    },
    body: JSON.stringify(body),
  });

  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`Trakt add-to-history error ${resp.status}: ${text}`);
  }
  return text ? JSON.parse(text) : { ok: true };
}

async function traktModifyWatchlist(action, ids) {
  ensureTraktConfigured();

  const url =
    action === "add"
      ? "https://api.trakt.tv/sync/watchlist"
      : "https://api.trakt.tv/sync/watchlist/remove";

  const body = {
    movies: [
      {
        ids: {
          ...(ids.trakt_id ? { trakt: ids.trakt_id } : {}),
          ...(ids.imdb ? { imdb: ids.imdb } : {}),
          ...(ids.slug ? { slug: ids.slug } : {}),
          ...(ids.tmdb ? { tmdb: ids.tmdb } : {}),
        },
      },
    ],
  };

  if (Object.keys(body.movies[0].ids).length === 0) {
    throw new Error(
      "No valid ids provided for Trakt watchlist (need trakt_id, imdb, slug or tmdb)"
    );
  }

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "trakt-api-version": "2",
      "trakt-api-key": TRAKT_CLIENT_ID,
      Authorization: `Bearer ${TRAKT_ACCESS_TOKEN}`,
    },
    body: JSON.stringify(body),
  });

  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`Trakt watchlist ${action} error ${resp.status}: ${text}`);
  }
  return text ? JSON.parse(text) : { ok: true };
}

// ---------- Routes -------------------------------------------------------

app.get("/", (req, res) => {
  res.json({
    ok: true,
    message: "Yen Cine Agent running",
    vectorStoreId: VECTOR_STORE_ID,
    traktConfigured: !!(TRAKT_CLIENT_ID && TRAKT_ACCESS_TOKEN),
    endpoints: {
      "POST /mark-seen":
        "Marca una película como vista. Escribe en el Vector Store y (opcionalmente) en Trakt.",
      "POST /import-trakt-history":
        "Importa el historial de Trakt (movies) al Vector Store.",
      "POST /trakt/watchlist/add":
        "Añade una película a la watchlist de Trakt y opcionalmente la registra en el Vector Store.",
      "POST /trakt/watchlist/remove":
        "Quita una película de la watchlist de Trakt y opcionalmente la registra en el Vector Store.",
      "POST /trakt/proxy":
        "Proxy genérico para llamar a cualquier endpoint de Trakt.",
      "POST /vector/write":
        "Escribe texto arbitrario en el vector store (memoria genérica).",
      "POST /vector/delete-file":
        "Elimina un archivo completo del vector store por file_id.",
      "POST /agent/chat":
        "Punto de entrada al cerebro YenMoviesAgent (Agents SDK + gpt-5.1).",
    },
  });
});

// Marca película como vista: vector store + opcionalmente Trakt history
app.post("/mark-seen", async (req, res) => {
  try {
    const {
      title,
      year,
      trakt_id,
      imdb,
      slug,
      tmdb,
      rating,
      liked,
      tags,
      comment,
      syncTrakt = true,
    } = req.body || {};

    if (!title || typeof title !== "string") {
      return res.status(400).json({ error: "title is required (string)" });
    }

    // 1) Escribir en Vector Store
    const doc = buildMovieDocument({
      type: "movie_seen",
      title,
      year,
      trakt_id,
      imdb,
      slug,
      tmdb,
      rating,
      liked,
      state: "seen",
      source: syncTrakt
        ? "mark_seen_trakt+vector"
        : "mark_seen_vector_only",
      tags,
      comment,
    });

    const { fileId } = await uploadTextToVectorStore(doc);

    // 2) Opcional: escribir en Trakt history
    let traktResult = null;
    if (
      syncTrakt &&
      (trakt_id || imdb || slug || tmdb) &&
      TRAKT_CLIENT_ID &&
      TRAKT_ACCESS_TOKEN
    ) {
      try {
        traktResult = await traktAddToHistory({
          trakt_id,
          imdb,
          slug,
          tmdb,
        });
      } catch (err) {
        console.error("⚠️ Error syncing to Trakt history:", err);
        traktResult = { error: String(err.message || err) };
      }
    }

    res.json({
      ok: true,
      stored: {
        title,
        year: year ?? null,
        trakt_id: trakt_id ?? null,
        imdb: imdb ?? null,
        slug: slug ?? null,
        tmdb: tmdb ?? null,
        rating: rating ?? null,
        liked: liked ?? null,
        tags: tags ?? [],
      },
      vectorStoreFileId: fileId,
      trakt: traktResult,
    });
  } catch (err) {
    console.error("❌ /mark-seen error:", err);
    res.status(500).json({
      error: "internal_error",
      details: String(err.message || err),
    });
  }
});

// Importa historial de Trakt (movies) al vector store
app.post("/import-trakt-history", async (req, res) => {
  try {
    const { limit } = req.body || {};
    const history = await traktFetchHistory(limit);

    if (!Array.isArray(history) || history.length === 0) {
      return res.json({
        ok: true,
        imported: 0,
        message: "No hay historial de Trakt o está vacío",
      });
    }

    const lines = history
      .filter((item) => item?.movie?.title)
      .map((item) =>
        buildMovieDocument({
          type: "movie_seen",
          title: item.movie.title,
          year: item.movie.year,
          trakt_id: item.movie.ids?.trakt ?? null,
          imdb: item.movie.ids?.imdb ?? null,
          slug: item.movie.ids?.slug ?? null,
          tmdb: item.movie.ids?.tmdb ?? null,
          rating: item.rating ?? null,
          liked: null,
          state: "seen",
          source: "trakt_history",
          tags: ["trakt_history"],
          comment: null,
        })
      )
      .join("");

    const { fileId } = await uploadTextToVectorStore(lines);

    res.json({
      ok: true,
      imported: history.length,
      vectorStoreFileId: fileId,
    });
  } catch (err) {
    console.error("❌ /import-trakt-history error:", err);
    res.status(500).json({
      error: "internal_error",
      details: String(err.message || err),
    });
  }
});

// Añadir a watchlist de Trakt (+ opcional vector store)
app.post("/trakt/watchlist/add", async (req, res) => {
  try {
    const {
      title,
      year,
      trakt_id,
      imdb,
      slug,
      tmdb,
      tags,
      comment,
      writeToVector = true,
    } = req.body || {};

    if (!(trakt_id || imdb || slug || tmdb)) {
      return res.status(400).json({
        error: "Need at least one id: trakt_id, imdb, slug or tmdb",
      });
    }

    let vectorFileId = null;
    if (writeToVector && title) {
      const doc = buildMovieDocument({
        type: "movie_watchlist",
        title,
        year,
        trakt_id,
        imdb,
        slug,
        tmdb,
        state: "in_watchlist",
        source: "trakt_watchlist_add",
        tags: tags ?? ["watchlist"],
        comment,
      });
      const resVS = await uploadTextToVectorStore(doc);
      vectorFileId = resVS.fileId;
    }

    const traktResult = await traktModifyWatchlist("add", {
      trakt_id,
      imdb,
      slug,
      tmdb,
    });

    res.json({
      ok: true,
      action: "add",
      watchlist: traktResult,
      vectorStoreFileId: vectorFileId,
    });
  } catch (err) {
    console.error("❌ /trakt/watchlist/add error:", err);
    res.status(500).json({
      error: "internal_error",
      details: String(err.message || err),
    });
  }
});

// Quitar de watchlist de Trakt (+ opcional vector store)
app.post("/trakt/watchlist/remove", async (req, res) => {
  try {
    const {
      title,
      year,
      trakt_id,
      imdb,
      slug,
      tmdb,
      tags,
      comment,
      writeToVector = true,
    } = req.body || {};

    if (!(trakt_id || imdb || slug || tmdb)) {
      return res.status(400).json({
        error: "Need at least one id: trakt_id, imdb, slug or tmdb",
      });
    }

    let vectorFileId = null;
    if (writeToVector && title) {
      const doc = buildMovieDocument({
        type: "movie_watchlist_removed",
        title,
        year,
        trakt_id,
        imdb,
        slug,
        tmdb,
        state: "removed_from_watchlist",
        source: "trakt_watchlist_remove",
        tags: tags ?? ["watchlist_removed"],
        comment,
      });
      const resVS = await uploadTextToVectorStore(doc);
      vectorFileId = resVS.fileId;
    }

    const traktResult = await traktModifyWatchlist("remove", {
      trakt_id,
      imdb,
      slug,
      tmdb,
    });

    res.json({
      ok: true,
      action: "remove",
      watchlist: traktResult,
      vectorStoreFileId: vectorFileId,
    });
  } catch (err) {
    console.error("❌ /trakt/watchlist/remove error:", err);
    res.status(500).json({
      error: "internal_error",
      details: String(err.message || err),
    });
  }
});

// ---------- Nuevo: proxy genérico para Trakt -----------------------------

app.post("/trakt/proxy", async (req, res) => {
  try {
    const { method, path: traktPath, bodyJson } = req.body || {};

    if (!["GET", "POST", "PUT", "DELETE"].includes(method)) {
      return res.status(400).json({
        ok: false,
        error: "Invalid method. Use GET, POST, PUT or DELETE.",
      });
    }

    if (!traktPath || typeof traktPath !== "string" || !traktPath.startsWith("/")) {
      return res.status(400).json({
        ok: false,
        error: "path must be a string starting with '/'.",
      });
    }

    ensureTraktConfigured();

    const url = `https://api.trakt.tv${traktPath}`;

    const fetchOptions = {
      method,
      headers: {
        "Content-Type": "application/json",
        "trakt-api-version": "2",
        "trakt-api-key": TRAKT_CLIENT_ID,
        Authorization: `Bearer ${TRAKT_ACCESS_TOKEN}`,
      },
    };

    if (bodyJson) {
      fetchOptions.body = bodyJson;
    }

    const resp = await fetch(url, fetchOptions);
    const text = await resp.text();

    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text };
    }

    res.json({
      ok: resp.ok,
      status: resp.status,
      url,
      data: json,
    });
  } catch (err) {
    console.error("❌ /trakt/proxy error:", err);
    res.status(500).json({
      ok: false,
      error: "internal_error",
      details: String(err.message || err),
    });
  }
});

// ---------- Nuevo: memoria genérica en vector store ----------------------

// Escribir texto arbitrario en el vector store
app.post("/vector/write", async (req, res) => {
  try {
    const { payloadText } = req.body || {};

    if (!payloadText || typeof payloadText !== "string") {
      return res.status(400).json({
        ok: false,
        error: "payloadText is required (string)",
      });
    }

    // Aseguramos que termina en salto de línea para JSONL-compatible
    const text = payloadText.endsWith("\n")
      ? payloadText
      : payloadText + "\n";

    const { fileId } = await uploadTextToVectorStore(text);

    res.json({
      ok: true,
      fileId,
    });
  } catch (err) {
    console.error("❌ /vector/write error:", err);
    res.status(500).json({
      ok: false,
      error: "internal_error",
      details: String(err.message || err),
    });
  }
});

// Eliminar un archivo completo del vector store
app.post("/vector/delete-file", async (req, res) => {
  try {
    const { file_id } = req.body || {};

    if (!file_id || typeof file_id !== "string") {
      return res.status(400).json({
        ok: false,
        error: "file_id is required (string)",
      });
    }

    const resp = await fetch(
      `https://api.openai.com/v1/vector_stores/${VECTOR_STORE_ID}/files/${file_id}`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "OpenAI-Beta": "assistants=v2",
        },
      }
    );

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(
        `Vector store delete failed ${resp.status}: ${body}`
      );
    }

    res.json({
      ok: true,
      file_id,
    });
  } catch (err) {
    console.error("❌ /vector/delete-file error:", err);
    res.status(500).json({
      ok: false,
      error: "internal_error",
      details: String(err.message || err),
    });
  }
});

// ---------- Endpoint del Agent (cerebro) --------------------------------

app.post("/agent/chat", async (req, res) => {
  try {
    const { message, sessionId } = req.body || {};

    if (!message || typeof message !== "string") {
      return res.status(400).json({
        ok: false,
        error: "message is required (string)",
      });
    }

    const result = await runYenMoviesAgent(message, {
      sessionId: sessionId || "default-session",
    });

    res.json({
      ok: true,
      reply: result.text,
    });
  } catch (err) {
    console.error("❌ /agent/chat error:", err);
    res.status(500).json({
      ok: false,
      error: "agent_internal_error",
      details: String(err.message || err),
    });
  }
});

// ---------- Start server -----------------------------------------------

const listenPort = PORT || 3000;
app.listen(listenPort, () => {
  console.log(`🎬 Yen Cine Agent listening on port ${listenPort}`);
});
