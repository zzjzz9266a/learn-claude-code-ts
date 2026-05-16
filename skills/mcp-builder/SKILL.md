---
name: mcp-builder
description: Build MCP (Model Context Protocol) servers that give Claude new capabilities. Use when user wants to create an MCP server, add tools to Claude, or integrate external services.
---

# MCP Server Building Skill

You now have expertise in building MCP (Model Context Protocol) servers. MCP enables Claude to interact with external services through a standardized protocol.

## What is MCP?

MCP servers expose:
- **Tools**: Functions Claude can call (like API endpoints)
- **Resources**: Data Claude can read (like files or database records)
- **Prompts**: Pre-built prompt templates

## Quick Start: TypeScript MCP Server

### 1. Project Setup

```bash
# Create project
mkdir my-mcp-server && cd my-mcp-server

# Install MCP SDK
npm init -y
npm install @modelcontextprotocol/sdk
npm install -D typescript tsx @types/node
```

### 2. Basic Server Template

```typescript
// src/server.ts - A simple MCP server
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new Server({ name: "my-server", version: "1.0.0" });

server.setRequestHandler("tools/list", async () => ({
  tools: [
    {
      name: "hello",
      description: "Say hello to someone",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
    },
    {
      name: "add_numbers",
      description: "Add two numbers together",
      inputSchema: {
        type: "object",
        properties: { a: { type: "number" }, b: { type: "number" } },
        required: ["a", "b"],
      },
    },
  ],
}));

server.setRequestHandler("tools/call", async (request) => {
  const args = request.params.arguments as Record<string, unknown>;

  if (request.params.name === "hello") {
    return { content: [{ type: "text", text: `Hello, ${args.name}!` }] };
  }

  if (request.params.name === "add_numbers") {
    return { content: [{ type: "text", text: String(Number(args.a) + Number(args.b)) }] };
  }

  throw new Error(`Unknown tool: ${request.params.name}`);
});

await server.connect(new StdioServerTransport());
```

### 3. Register with Claude

Add to `~/.claude/mcp.json`:
```json
{
  "mcpServers": {
    "my-server": {
      "command": "node",
      "args": ["/path/to/dist/server.js"]
    }
  }
}
```

## TypeScript MCP Server

### 1. Setup

```bash
mkdir my-mcp-server && cd my-mcp-server
npm init -y
npm install @modelcontextprotocol/sdk
```

### 2. Template

```typescript
// src/index.ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new Server({
  name: "my-server",
  version: "1.0.0",
});

// Define tools
server.setRequestHandler("tools/list", async () => ({
  tools: [
    {
      name: "hello",
      description: "Say hello to someone",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Name to greet" },
        },
        required: ["name"],
      },
    },
  ],
}));

server.setRequestHandler("tools/call", async (request) => {
  if (request.params.name === "hello") {
    const name = request.params.arguments.name;
    return { content: [{ type: "text", text: `Hello, ${name}!` }] };
  }
  throw new Error("Unknown tool");
});

// Start server
const transport = new StdioServerTransport();
server.connect(transport);
```

## Advanced Patterns

### External API Integration

```typescript
server.setRequestHandler("tools/call", async (request) => {
  if (request.params.name !== "get_weather") throw new Error("Unknown tool");

  const { city } = request.params.arguments as { city: string };
  const url = new URL("https://api.weatherapi.com/v1/current.json");
  url.searchParams.set("key", "YOUR_API_KEY");
  url.searchParams.set("q", city);

  const response = await fetch(url);
  const data = await response.json() as {
    current: { temp_c: number; condition: { text: string } };
  };

  return {
    content: [{ type: "text", text: `${city}: ${data.current.temp_c}C, ${data.current.condition.text}` }],
  };
});
```

### Database Access

```typescript
import Database from "better-sqlite3";

server.setRequestHandler("tools/call", async (request) => {
  if (request.params.name !== "query_db") throw new Error("Unknown tool");

  const { sql } = request.params.arguments as { sql: string };
  if (!sql.trim().toUpperCase().startsWith("SELECT")) {
    return { content: [{ type: "text", text: "Error: Only SELECT queries allowed" }] };
  }

  const db = new Database("data.db", { readonly: true });
  const rows = db.prepare(sql).all();
  db.close();
  return { content: [{ type: "text", text: JSON.stringify(rows) }] };
});
```

### Resources (Read-only Data)

```typescript
import { readFile } from "node:fs/promises";

server.setRequestHandler("resources/read", async (request) => {
  if (request.params.uri === "config://settings") {
    return {
      contents: [{ uri: request.params.uri, mimeType: "application/json", text: await readFile("settings.json", "utf8") }],
    };
  }

  throw new Error(`Unknown resource: ${request.params.uri}`);
});
```

## Testing

```bash
# Test with MCP Inspector
npx @modelcontextprotocol/inspector node dist/server.js

# Or send test messages directly
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node dist/server.js
```

## Best Practices

1. **Clear tool descriptions**: Claude uses these to decide when to call tools
2. **Input validation**: Always validate and sanitize inputs
3. **Error handling**: Return meaningful error messages
4. **Async by default**: Use async/await for I/O operations
5. **Security**: Never expose sensitive operations without auth
6. **Idempotency**: Tools should be safe to retry
