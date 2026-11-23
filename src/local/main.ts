// Starts the local edition: npm start, or the talqava command the installer adds.
//   --open   also open the app in the browser once it is ready
import { execFile } from "node:child_process";
import { start } from "./server.ts";

const server = start();

if (process.argv.includes("--open")) {
  server.once("listening", () => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 8787;
    const url = `http://localhost:${port}`;
    const [command, args] =
      process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
    // If no browser can be opened (a server, a terminal-only machine), the address printed above is enough.
    execFile(command, args, () => {});
  });
}
