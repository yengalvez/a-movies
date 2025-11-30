// src/yen-agent.mjs
import { Agent, run, tool } from "@openai/agents";
import {
  OpenAIResponsesModel,
  webSearchTool,
  fileSearchTool,
} from "@openai/agents-openai";
import { z } from "zod";
import fetch from "node-fetch";

// ---------- Modelo OpenAI (Responses + gpt-5.1) ----------

const model = new OpenAIResponsesModel({
  model: "gpt-5.1",
  clientOptions: {
    apiKey: process.env.OPENAI_API_KEY,
  },
});

// ---------- Tool: backend de Yen en Railway ----------

const YEN_BACKEND_URL =
  process.env.YEN_BACKEND_URL || "https://a-movies-production.up.railway.app";

const yenBackendTool = tool({
  name: "yen_backend",
  description: `
Llama al backend de cine de Yen en Railway.
Úsalo para:
- Marcar películas/series como vistas (/mark-seen).
- Importar historial de Trakt (/import-trakt-history).
- Gestionar watchlist (/trakt/watchlist/add, /trakt/watchlist/remove).
`.trim(),
  parameters: z.object({
    path: z.enum([
      "/mark-seen",
      "/import-trakt-history",
      "/trakt/watchlist/add",
      "/trakt/watchlist/remove",
    ]),
    method: z.enum(["GET", "POST"]).default("POST"),
    // IMPORTANTE: no optional(), solo nullable() para que la API no se queje
    body: z
      .record(z.any())
      .nullable()
      .describe(
        "Cuerpo JSON a enviar al backend, según el endpoint. Usa null cuando no haga falta enviar body."
      ),
  }),
  strict: true,
  async execute({ path, method, body }) {
    const url = `${YEN_BACKEND_URL}${path}`;

    const res = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
      },
      // Solo mandamos body si existe y no es null
      body:
        method === "POST" && body != null
          ? JSON.stringify(body)
          : undefined,
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
    yenBackendTool,
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
- yen_backend:
  - Úsalo cuando quieras ESCRIBIR o SINCRONIZAR:
    - /mark-seen:
      - Cuando Yen te diga que ha visto algo o quieras marcarlo como visto en memoria.
      - body típico:
        { title, year?, trakt_id?, imdb?, slug?, tmdb?,
          rating?, liked?, tags?, comment?, syncTrakt? (bool) }
    - /import-trakt-history:
      - Para importar / refrescar el historial completo de Trakt al vector store.
      - body típico: { limit?: number }
    - /trakt/watchlist/add:
      - Para añadir algo a la watchlist de Trakt y opcionalmente al vector store.
      - body típico:
        { title?, year?, trakt_id?, imdb?, slug?, tmdb?,
          tags?, comment?, writeToVector?: boolean }
    - /trakt/watchlist/remove:
      - Igual que add pero para quitar de watchlist, mismo body.

Comportamiento:
- Entiende siempre primero la intención del usuario.
- Si Yen dice que ha visto algo nuevo:
  - Usa yen_backend -> /mark-seen para actualizar memoria (y Trakt si procede).
- Si pide importar o refrescar historial de Trakt:
  - Usa yen_backend -> /import-trakt-history.
- Si pide gestionar watchlist:
  - Usa yen_backend -> /trakt/watchlist/add o /trakt/watchlist/remove.
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
