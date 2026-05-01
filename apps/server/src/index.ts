import { createServer } from "http";
import { config } from "./config/env";
import { createApp } from "./app";
import { setupSocket } from "./realtime/socket";
import { startWorkers } from "./workers";

const app = createApp();
const server = createServer(app);
setupSocket(server);
startWorkers();

server.listen(config.port, () => {
  console.log(`PullVault server listening on :${config.port}`);
});
