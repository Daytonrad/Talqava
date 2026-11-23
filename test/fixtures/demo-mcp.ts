// A tiny connector (MCP server) for tests: one tool that only reads, one that changes something.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "demo", version: "1.0.0" });
server.registerTool(
  "echo",
  { description: "Repeats the text.", inputSchema: { text: z.string() }, annotations: { readOnlyHint: true } },
  async ({ text }) => ({ content: [{ type: "text", text: `echo: ${text}` }] }),
);
server.registerTool(
  "save_note",
  { description: "Saves a note somewhere.", inputSchema: { note: z.string() } },
  async ({ note }) => ({ content: [{ type: "text", text: `saved ${note.length} characters` }] }),
);
server.registerTool("fail", { description: "Always fails.", inputSchema: {} }, async () => ({ isError: true, content: [{ type: "text", text: "the demo failed on purpose" }] }));
await server.connect(new StdioServerTransport());
