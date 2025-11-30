// src/yen-agent.mjs
import { Agent, run, tool } from "@openai/agents";
import {
  OpenAIResponsesModel,
  webSearchTool,
  fileSearchTool,
} from "@openai/agents-openai";
import OpenAI from "openai";
import { z } from "zod";
import fetch from "node-fetch";

// ---------- Cliente OpenAI (Responses + gpt-5.1) ----------

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const model = new OpenAIResponsesModel(openai, "gpt-5.1");

// ---------- Config común ----------

const YEN_BACKEND_URL =
  process.env.YEN_BACKEND_URL || "https://a-movies-production.up.railway.app";

// ---------- Tool 1: marcar película/serie como vista ----------

const markSeenTool = tool({
  name: "yen_mark_seen",
  description: `
Marca una película o serie como vista en el backend de Yen.
Escribe en el vector store y opcionalmente sincroniza con Trakt (/mark-seen).
`.trim(),
  parameters: z
    .object({
      title: z.string().describe("Título de la película o serie."),
      year: z
        .number()
        .int()
        .nullable()
        .describe("Año de estreno o null si no se sabe."),
      trakt_id: z
        .string()
        .nullable()
        .describe("ID de Trakt si se conoce, si no null."),
      imdb: z
        .string()
        .nullable()
        .describe("ID de IMDb (ej: tt0816692) o null."),
      slug: z
        .string()
        .nullable()
        .describe("Slug de Trakt si se conoce, o null."),
      tmdb: z
        .string()
        .nullable()
        .describe("ID de TMDB si se conoce, o null."),
      rating: z
        .number()
        .nullable()
        .describe(
          "Nota personal de Yen (0-10 aprox) o null si no ha dado nota."
        ),
      liked: z
        .boolean()
        .nullable()
        .describe("true si le ha gustado, false si no, o null si no aplica."),
      tags: z
        .array(z.string())
        .nullable()
        .describe(
          "Lista de tags (ej: ['space','favorite']) o null si no hay tags."
        ),
      comment: z
        .string()
        .nullable()
        .describe("Comentario libre de Yen o null."),
      syncTrakt: z
        .boolean()
        .nullable()
        .describe(
          "true para sincronizar con Trakt, false para solo vector store, null para dejar por defecto (true)."
        ),
    })
    .strict(),
  strict: true,
  async execute(args) {
    const url = `${YEN_BACKEND_URL}/mark-seen`;

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(args),
    });

    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text };
    }

    return {
      status: res.status,
      ok: res.ok,
      url,
      data: json,
    };
  },
});

// ---------- Tool 2: importar historial de Trakt ----------

const importTraktHistoryTool = tool({
  name: "yen_import_trakt_history",
  description: `
Importa el historial de películas vistas desde Trakt al vector store
usando el endpoint /import-trakt-history.
`.trim(),
  parameters: z
    .object({
      limit: z
        .number()
        .int()
        .nullable()
        .describe(
          "Máximo de elementos a importar. Usa null para el valor por defecto del backend."
        ),
    })
    .strict(),
  strict: true,
  async execute({ limit }) {
    const url = `${YEN_BACKEND_URL}/import-trakt-history`;

    const body = { limit };

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text };
    }

    return {
      status: res.status,
      ok: res.ok,
      url,
      data: json,
    };
  },
});

// ---------- Tool 3: añadir a watchlist de Trakt ----------

const watchlistAddTool = tool({
  name: "yen_watchlist_add",
  description: `
Añade una película a la watchlist de Trakt y opcionalmente al vector store
usando el endpoint /trakt/watchlist/add.
`.trim(),
  parameters: z
    .object({
      title: z
        .string()
        .nullable()
        .describe(
          "Título de la película (recomendado si quieres escribir en el vector store)."
        ),
      year: z
        .number()
        .int()
        .nullable()
        .describe("Año o null."),
      trakt_id: z
        .string()
        .nullable()
        .describe("ID de Trakt si se conoce, o null."),
      imdb: z
        .string()
        .nullable()
        .describe("ID de IMDb (ej: tt0816692) o null."),
      slug: z
        .string()
        .nullable()
        .describe("Slug de Trakt o null."),
      tmdb: z
        .string()
        .nullable()
        .describe("ID de TMDB o null."),
      tags: z
        .array(z.string())
        .nullable()
        .describe("Lista de tags o null."),
      comment: z
        .string()
        .nullable()
        .describe("Comentario libre o null."),
      writeToVector: z
        .boolean()
        .nullable()
        .describe(
          "true para escribir también en el vector store si hay título, false para sólo Trakt, null para usar el valor por defecto del backend (true)."
        ),
    })
    .strict(),
  strict: true,
  async execute(args) {
    const url = `${YEN_BACKEND_URL}/trakt/watchlist/add`;

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(args),
    });

    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text };
    }

    return {
      status: res.status,
      ok: res.ok,
      url,
      data: json,
    };
  },
});

// ---------- Tool 4: quitar de watchlist de Trakt ----------

const watchlistRemoveTool = tool({
  name: "yen_watchlist_remove",
  description: `
Quita una película de la watchlist de Trakt y opcionalmente escribe el evento
en el vector store usando /trakt/watchlist/remove.
`.trim(),
  parameters: z
    .object({
      title: z
        .string()
        .nullable()
        .describe(
          "Título de la película (sólo necesario si quieres registrar el evento en el vector store)."
        ),
      year: z
        .number()
        .int()
        .nullable()
        .describe("Año o null."),
      trakt_id: z
        .string()
        .nullable()
        .describe("ID de Trakt si se conoce, o null."),
      imdb: z
        .string()
        .nullable()
        .describe("ID de IMDb o null."),
      slug: z
        .string()
        .nullable()
        .describe("Slug de Trakt o null."),
      tmdb: z
        .string()
        .nullable()
        .describe("ID de TMDB o null."),
      tags: z
        .array(z.string())
        .nullable()
        .describe("Lista de tags o null."),
      comment: z
        .string()
        .nullable()
        .describe("Comentario libre o null."),
      writeToVector: z
        .boolean()
        .nullable()
        .describe(
          "true para escribir en el vector store si hay título, false para sólo Trakt, null para usar el valor por defecto del backend (true)."
        ),
    })
    .strict(),
  strict: true,
  async execute(args) {
    const url = `${YEN_BACKEND_URL}/trakt/watchlist/remove`;

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(args),
    });

    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text };
    }

    return {
      status: res.status,
      ok: res.ok,
      url,
      data: json,
    };
  },
});

// ---------- Agent principal: YenMoviesAgent ----------

export const yenMoviesAgent = new Agent({
  name: "YenMoviesAgent",
  model,
  tools: [
    webSearchTool(),
    fileSearchTool(process.env.VECTOR_STORE_ID),
    markSeenTool,
    importTraktHistoryTool,
    watchlistAddTool,
    watchlistRemoveTool,
  ],
  instructions: `
Eres el cerebro de las recomendaciones de cine y series de Yen.

Contexto:
- Tu memoria persistente vive en un vector store llamado YenVectorMovies.
  - Contiene documentos JSONL con películas vistas, importadas desde Trakt y watchlist.
  - Campos típicos: type, title, year, ids (trakt_id, imdb, tmdb, slug),
    rating, liked, state, source, tags, comment, marked_at.
- El backend de Yen en Railway escribe en ese vector store y sincroniza con Trakt.

Objetivos:
1) Recordar lo que Yen ha visto, lo que tiene en watchlist y sus preferencias.
2) Darle recomendaciones de películas/series que encajen con sus gustos.
3) Mantener la memoria actualizada cuando te diga que ha visto algo nuevo
   o modifique su watchlist.
4) Usar la web para enriquecer información (sinopsis, críticas, dónde ver, etc.).

Herramientas:
- file_search (YenVectorMovies):
  - Úsalo para:
    - Saber si una película ya se ha visto.
    - Leer watchlist y notas asociadas (tags, comment).
    - Consultar historial importado de Trakt.
- web_search:
  - Úsalo para:
    - Obtener información actualizada (fechas de estreno, puntuaciones, plataformas).
    - Investigar películas o series que no estén en memoria.
- yen_mark_seen:
  - Úsalo cuando Yen diga que ha visto algo nuevo o quieras marcarlo como visto.
  - Pasa título y año si los conoces, y los IDs que tengas (trakt_id, imdb, slug, tmdb).
  - Si algo no lo sabes, pon null.
- yen_import_trakt_history:
  - Úsalo cuando te pida importar o refrescar su historial de Trakt.
  - Si no estás seguro del límite, usa limit = null y deja que el backend decida.
- yen_watchlist_add:
  - Úsalo para añadir a la watchlist de Trakt.
  - Debes proporcionar al menos un ID (trakt_id, imdb, slug o tmdb).
  - Si también quieres que se registre en el vector store, pasa title y opcionalmente year, tags, comment.
- yen_watchlist_remove:
  - Úsalo para quitar de la watchlist de Trakt.
  - Igual: necesitas al menos un ID, y opcionalmente title/year/tags/comment si quieres registrar el evento.

Comportamiento:
- Entiende siempre primero la intención del usuario.
- Si Yen dice que ha visto algo nuevo:
  - Llama a yen_mark_seen.
- Si pide importar o refrescar historial de Trakt:
  - Llama a yen_import_trakt_history.
- Si pide gestionar watchlist:
  - Usa yen_watchlist_add o yen_watchlist_remove.
- Si necesitas saber qué ha visto o qué tiene en watchlist:
  - Usa file_search sobre YenVectorMovies.
- Si necesitas datos adicionales o descubrir nuevas pelis/series:
  - Usa web_search.

Siempre responde en el idioma de Yen (normalmente español),
explicando brevemente qué has consultado o cambiado (memoria, Trakt, etc.).
`.trim(),
});

// ---------- Helper para llamarlo desde server.mjs ----------

export async function runYenMoviesAgent(input, options = {}) {
  const { sessionId } = options;

  const result = await run(yenMoviesAgent, input, {
    sessionId: sessionId || "default-session",
  });

  const output = result.finalOutput ?? result.output ?? "";
  return {
    raw: result,
    text: typeof output === "string" ? output : JSON.stringify(output),
  };
}
