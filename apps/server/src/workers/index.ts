import { config } from "../config/env";
import { settlementTick } from "../services/auctionService";
import { runPriceTick } from "../services/priceEngineService";
import { refreshCardPool } from "../services/pokemonCardService";

export function startWorkers() {
  refreshCardPool().catch((e) => console.error("card pool refresh error", e));

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
