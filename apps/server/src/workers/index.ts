import { config } from "../config/env";
import { settlementTick } from "../services/auctionService";
import { runPriceTick } from "../services/priceEngineService";
import { refreshCardPool } from "../services/pokemonCardService";
import { syncDrops } from "../services/packService";

export function startWorkers() {
  console.log("Starting background workers...");
  refreshCardPool().catch((e) => console.error("card pool refresh error", e));

  // Sync drop state (price/status) from DB to sockets every 3 seconds
  setInterval(async () => {
    try {
      await syncDrops();
    } catch (e) {
      console.error("drop sync worker error", e);
    }
  }, 3000);

  setInterval(async () => {
    try {
      await settlementTick(config.platformUserId);
    } catch (e) {
      console.error("settlement worker error", e);
    }
  }, 5000);

  setInterval(async () => {
    try {
      await runPriceTick();
    } catch (e) {
      console.error("price tick error", e);
    }
  }, config.priceTickSeconds * 1000);
}
