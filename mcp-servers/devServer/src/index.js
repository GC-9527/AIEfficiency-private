import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

import { createAppMarketServer } from "./server.js";
import { publicError } from "./security.js";

export async function main() {
  const { server } = createAppMarketServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(
    `${JSON.stringify({
      level: "info",
      service: "appmarket-admin-readonly",
      message: "MCP stdio server started",
    })}\n`
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify(publicError(error))}\n`);
    process.exitCode = 1;
  });
}
