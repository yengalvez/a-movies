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

const YEN_BACKEND_URL =
  process.env.YEN_BACKEND_URL ||
  "https://a-movies-production.up.railway.app";

// ---------- Tool genérico 1: martillo Trakt ------------------------------

const traktTool = tool({
  name: "yen_trakt",
  description: `
Martillo genérico para Trakt. 
Permite llamar a CUALQUIER endpoint de la API de Trakt a través del backend de Yen.
Úsalo para gestionar historial, watchlist u otras operaciones cuando conozcas
o descubras el endpoint adecuado leyendo la documentación de Trakt en la web.
`.trim(),
  parameters: z
    .object({
      method: z
        .enum(["GET", "POST", "PUT", "DELETE"])
        .describe("Método HTTP a usar contra Trakt."),
      path: z
        .string()
        .describe(
          "Ruta relativa de Trakt empezando por '/', por ejemplo '/sync/history/remove'."
        ),
      bodyJson: z
        .string()
        .nullable()
        .describe(
          "Cuerpo JSON como string (por ejemplo '{\"movies\":[...]}') o null si no hay body."
        ),
    })
    .strict(),
  strict: true,
  async execute({ method, path, bodyJson }) {
    const url = `${YEN_BACKEND_URL}/trakt/proxy`;

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        method,
        path,
        bodyJson,
      }),
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

// ---------- Tool genérico 2: martillo Memoria/Vector Store ---------------

const memoryTool = tool({
  name: "yen_memory",
  description: `
Martillo genérico de memoria para Yen.
Escribe o borra información en el vector store persistente de Yen (YenVectorMovies)
a través del backend de Yen.

Úsalo para:
- Guardar gustos, moods, notas, listas de pelis vistas, reglas, webs favoritas, etc.
- Opcionalmente, eliminar archivos completos del vector store cuando tengas su fileId.

Para buscar o leer memoria, usa SIEMPRE file_search, no este tool.
`.trim(),
  parameters: z
    .object({
      operation: z
        .enum(["write", "delete"])
        .describe(
          "Operación a realizar: 'write' para escribir memoria, 'delete' para borrar un archivo concreto del vector store."
        ),
      payloadJson: z
        .string()
        .nullable()
        .describe(
          "Contenido a escribir cuando operation='write'. Debe ser un JSON string describiendo lo que quieres recordar."
        ),
      fileId: z
        .string()
        .nullable()
        .describe(
          "ID de archivo de vector store a eliminar cuando operation='delete'."
        ),
    })
    .strict(),
  strict: true,
  async execute({ operation, payloadJson, fileId }) {
    if (operation === "write") {
      if (!payloadJson) {
        throw new Error(
          "yen_memory.write requiere payloadJson (string JSON) no nulo."
        );
      }

      const res = await fetch(`${YEN_BACKEND_URL}/vector/write`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          payloadText: payloadJson,
        }),
      });

      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = { raw: text };
      }

      return {
        operation,
        status: res.status,
        ok: res.ok,
        data: json,
      };
    } else {
      if (!fileId) {
        throw new Error(
          "yen_memory.delete requiere fileId (string) no nulo."
        );
      }

      const res = await fetch(`${YEN_BACKEND_URL}/vector/delete-file`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          file_id: fileId,
        }),
      });

      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = { raw: text };
      }

      return {
        operation,
        status: res.status,
        ok: res.ok,
        data: json,
      };
    }
  },
});

// ---------- Agent principal: YenMoviesAgent ------------------------------

export const yenMoviesAgent = new Agent({
  name: "YenMoviesAgent",
  model,
  tools: [
    webSearchTool(),
    fileSearchTool(process.env.VECTOR_STORE_ID),
    traktTool,
    memoryTool,
  ],
  instructions: `
Eres el cerebro de cine/series y memoria multimedia de Yen.

Tienes:
- Un vector store persistente (YenVectorMovies) accesible vía file_search y yen_memory.
- Trakt como backend externo para historial, watchlist y otros datos de cuenta,
  accesible de forma genérica vía yen_trakt.
- Acceso a la web para encontrar endpoints de Trakt, información de pelis/series,
  plataformas de streaming, etc.

PIENSA EN TÉRMINOS DE 4 OPERACIONES GENÉRICAS:

1) BUSCAR / LEER:
   - Usa SIEMPRE:
     - file_search → para leer la memoria persistente en el vector store.
     - web_search → para información externa, doc de Trakt, fichas de pelis, etc.

2) ESCRIBIR MEMORIA:
   - Usa yen_memory con operation='write'.
   - payloadJson debe ser un string JSON que describa lo que quieras recordar.
     Por ejemplo:
       {"type":"mood","value":"quiere terror espacial slow-burn","timestamp":"..."}
       {"type":"movie_seen","title":"Ash","year":2025,"tags":["space_horror"]}

3) BORRAR MEMORIA:
   - Si en algún momento quieres eliminar un archivo concreto del vector store,
     usa yen_memory con operation='delete' y fileId igual al fileId devuelto
     anteriormente por yen_memory.write o por el backend.

4) ACCIONES EN TRAKT:
   - Usa yen_trakt como martillo genérico para cualquier endpoint:
     - method: GET, POST, PUT o DELETE
     - path: ruta de Trakt empezando por '/', ej:
         '/sync/history'
         '/sync/history/remove'
         '/sync/watchlist'
         '/sync/watchlist/remove'
     - bodyJson: JSON string con el cuerpo que exige Trakt.
   - Cuando no sepas el endpoint exacto:
     - Usa web_search para consultar la documentación de Trakt.
     - Después llama a yen_trakt con los parámetros correctos.

COMPORTAMIENTO:

- Antes de recomendar nada, intenta entender:
  - Qué ha visto Yen (consulta file_search).
  - Qué le gusta / mood actual (notas previas en la memoria, tipo 'mood' o 'preferences').
- Cuando Yen te diga que ha visto algo, o exprese un gusto estable, o una nueva regla:
  - Guarda esa info con yen_memory.write en un JSON que sea fácil de interpretar
    en el futuro (usa campos como type, title, year, tags, comment, source, timestamp).
- Cuando cambies algo en Trakt (historial, watchlist, etc.):
  - Siempre que tenga sentido, refleja ese cambio también en la memoria con yen_memory.write
    para mantener un diario coherente de eventos (por ejemplo type='trakt_event').

- Gestiona sesiones usando el sessionId que recibas del backend: 
  el contexto de conversación viene dado por el parámetro sessionId que te pasa run().

Responde SIEMPRE en el idioma de Yen (normalmente español) y explica de forma breve
qué has hecho con tus herramientas (por ejemplo: "he consultado tu memoria",
"he actualizado Trakt", "he guardado una nota de gusto", etc.).
`.trim(),
});

// ---------- Helper para llamarlo desde server.mjs ------------------------

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
