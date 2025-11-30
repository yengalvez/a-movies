// src/mcp-server.mjs
import dotenv from "dotenv";
import fetch from "node-fetch";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { uploadTextToVectorStore } from "./vector-helpers.mjs";

if (!process.env.RAILWAY_ENVIRONMENT) {
  dotenv.config();
}

const {
  OPENAI_API_KEY,
  VECTOR_STORE_ID,
  TRAKT_CLIENT_ID,
  TRAKT_ACCESS_TOKEN,
} = process.env;

if (!OPENAI_API_KEY) {
  console.error("❌ Missing OPENAI_API_KEY for MCP server");
}

if (!VECTOR_STORE_ID) {
  console.error("❌ Missing VECTOR_STORE_ID for MCP server");
}

// --- Helper: búsqueda naive sobre ficheros del vector store -------------
async function naiveVectorStoreSearch({ query, topK, filterTags }) {
  if (!OPENAI_API_KEY || !VECTOR_STORE_ID) {
    throw new Error("OPENAI_API_KEY or VECTOR_STORE_ID not configured");
  }

  const listResp = await fetch(
    `https://api.openai.com/v1/vector_stores/${VECTOR_STORE_ID}/files?limit=20`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
        "OpenAI-Beta": "assistants=v2",
      },
    }
  );

  if (!listResp.ok) {
    const body = await listResp.text();
    throw new Error(`Vector store list failed ${listResp.status}: ${body}`);
  }

  const listData = await listResp.json();
  const files = Array.isArray(listData.data) ? listData.data : [];

  const results = [];
  const queryLower = query.toLowerCase();
  const maxResults = topK || 10;
  const requiredTags = filterTags && filterTags.length > 0 ? filterTags : null;

  for (const file of files) {
    if (results.length >= maxResults) break;

    const fileResp = await fetch(
      `https://api.openai.com/v1/files/${file.id}/content`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
        },
      }
    );

    if (!fileResp.ok) {
      console.warn(
        `⚠️ Error fetching file content ${file.id}: ${fileResp.status}`
      );
      continue;
    }

    const text = await fileResp.text();
    if (!text) continue;

    const lines = text.split("\n").filter((line) => line.trim().length > 0);

    for (const line of lines) {
      if (results.length >= maxResults) break;

      let doc;
      try {
        doc = JSON.parse(line);
      } catch {
        continue;
      }

      const tags = Array.isArray(doc.tags) ? doc.tags : [];
      if (requiredTags) {
        const hasAll = requiredTags.every((t) => tags.includes(t));
        if (!hasAll) continue;
      }

      const haystack = (
        (doc.text || "") +
        " " +
        (doc.title || "") +
        " " +
        (doc.comment || "") +
        " " +
        JSON.stringify(tags) +
        " " +
        (doc.kind || "") +
        " " +
        (doc.type || "")
      ).toLowerCase();

      if (!haystack.includes(queryLower)) continue;

      results.push({
        text: doc.text || doc.title || JSON.stringify(doc),
        kind: doc.kind || doc.type || "unknown",
        tags,
        created_at: doc.created_at || doc.marked_at || null,
        score: 1,
      });
    }
  }

  return results.slice(0, maxResults);
}

function registerYenMoviesTools(server) {
  // --------- Tool: trakt_request --------------------

  const traktRequestSchema = z.object({
    method: z.enum(["GET", "POST", "PUT", "DELETE"]),
    path: z.string().min(1),
    query: z.record(z.string(), z.string()).optional(),
    body: z.record(z.string(), z.any()).optional(),
    reason: z.string().min(5),
  });

  const traktResponseSchema = z.object({
    status: z.number(),
    ok: z.boolean(),
    headers: z.record(z.string(), z.string()).optional(),
    data: z.any(),
  });

  server.registerTool(
    "trakt_request",
    {
      title: "Trakt generic HTTP request",
      description:
        "Realiza una petición genérica a la API de Trakt usando las credenciales del servidor. Úsalo para leer o modificar historial, watchlist o buscar contenido.",
      inputSchema: traktRequestSchema,
      outputSchema: traktResponseSchema,
    },
    async ({ method, path, query, body }) => {
      if (!TRAKT_CLIENT_ID || !TRAKT_ACCESS_TOKEN) {
        throw new Error("Trakt no está configurado en el servidor");
      }

      if (!path.startsWith("/")) {
        throw new Error("El path de Trakt debe empezar por '/'");
      }

      const qs =
        query && Object.keys(query).length > 0
          ? "?" +
            Object.entries(query)
              .map(
                ([k, v]) =>
                  `${encodeURIComponent(k)}=${encodeURIComponent(v)}`
              )
              .join("&")
          : "";

      const url = `https://api.trakt.tv${path}${qs}`;

      const options = {
        method,
        headers: {
          "Content-Type": "application/json",
          "trakt-api-version": "2",
          "trakt-api-key": TRAKT_CLIENT_ID,
          Authorization: `Bearer ${TRAKT_ACCESS_TOKEN}`,
        },
      };

      if (body && method !== "GET") {
        options.body = JSON.stringify(body);
      }

      const resp = await fetch(url, options);
      const text = await resp.text();

      let data;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = text;
      }

      const output = {
        status: resp.status,
        ok: resp.ok,
        headers: {
          "x-ratelimit": resp.headers.get("x-ratelimit") || "",
        },
        data,
      };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(output, null, 2),
          },
        ],
        structuredContent: output,
      };
    }
  );

  // --------- Tool: memory_write --------------------

  const memoryWriteSchema = z.object({
    kind: z.string(),
    text: z.string().min(1),
    source: z.string(),
    tags: z.array(z.string()).optional(),
  });

  const memoryWriteResponseSchema = z.object({
    ok: z.boolean(),
    vectorStoreFileId: z.string(),
  });

  server.registerTool(
    "memory_write",
    {
      title: "Persistent memory write",
      description:
        "Guarda una nota persistente en el vector store YenVectorMovies. Úsalo para registrar pelis vistas, watchlist, gustos, moods, notas de perfil, etc.",
      inputSchema: memoryWriteSchema,
      outputSchema: memoryWriteResponseSchema,
    },
    async ({ kind, text, source, tags }) => {
      const now = new Date().toISOString();

      const doc =
        JSON.stringify({
          kind,
          text,
          source,
          tags: tags || [],
          created_at: now,
        }) + "\n";

      const { fileId } = await uploadTextToVectorStore(doc);

      const output = {
        ok: true,
        vectorStoreFileId: fileId,
      };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(output, null, 2),
          },
        ],
        structuredContent: output,
      };
    }
  );

  // --------- Tool: memory_search --------------------

  const memorySearchSchema = z.object({
    query: z.string().min(1),
    top_k: z.number().int().min(1).max(50).optional(),
    filter_tags: z.array(z.string()).optional(),
  });

  const memorySearchResponseSchema = z.object({
    results: z.array(
      z.object({
        text: z.string(),
        kind: z.string().optional(),
        tags: z.array(z.string()).optional(),
        created_at: z.string().nullable().optional(),
        score: z.number().optional(),
      })
    ),
  });

  server.registerTool(
    "memory_search",
    {
      title: "Persistent memory search",
      description:
        "Busca en la memoria persistente de Yen (vector store) textos relacionados con una consulta.",
      inputSchema: memorySearchSchema,
      outputSchema: memorySearchResponseSchema,
    },
    async ({ query, top_k, filter_tags }) => {
      const results = await naiveVectorStoreSearch({
        query,
        topK: top_k || 10,
        filterTags: filter_tags || null,
      });

      const output = { results };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(output, null, 2),
          },
        ],
        structuredContent: output,
      };
    }
  );
}

// --------- Express glue: handleMcpRequest --------------------

export async function handleMcpRequest(req, res) {
  const server = new McpServer({
    name: "yen-movies-mcp",
    version: "1.0.0",
  });

  registerYenMoviesTools(server);

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless, ChatGPT lleva el contexto
    enableJsonResponse: true,
  });

  res.on("close", () => {
    transport.close();
    server.close();
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}
