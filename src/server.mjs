import express from "express";
import dotenv from "dotenv";
import OpenAI from "openai";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import fetch from "node-fetch";

// Cargar variables de entorno
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
    `yen-movie-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`
  );

  await fs.promises.writeFile(tmpPath, text, "utf8");

  try {
    // 1) Subir archivo a OpenAI Files
    const file = await openai.files.create({
      file: fs.createReadStream(tmpPath),
      purpose: "assistants",
    });

    // 2) Adjuntarlo al vector store
    await openai.beta.vectorStores.files.createAndPoll(VECTOR_STORE_ID, {
      file_id: file.id,
    });

    console.log("✅ Uploaded to vector store. file.id =", file.id);
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

// ---------- Start server -----------------------------------------------

const listenPort = PORT || 3000;
app.listen(listenPort, () => {
  console.log(`🎬 Yen Cine Agent listening on port ${listenPort}`);
});
