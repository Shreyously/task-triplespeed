import { createServer } from "http";
import { config } from "./config/env";
import { createApp } from "./app";
import { setupSocket } from "./realtime/socket";
import { startWorkers } from "./workers";

const app = createApp();
const server = createServer(app);
setupSocket(server);
startWorkers().catch((e) => {
  console.error("Failed to start workers:", e);
  process.exit(1);
});

server.listen(config.port, () => {
  console.log(`PullVault server listening on :${config.port}`);
  console.log(`Price tick interval: ${config.priceTickSeconds}s`);
});
