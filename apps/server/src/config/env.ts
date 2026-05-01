import "dotenv/config";

export const config = {
  port: Number(process.env.PORT ?? 4000),
  corsOrigin: process.env.CORS_ORIGIN ?? "http://localhost:3000",
  jwtSecret: process.env.JWT_SECRET ?? "dev-secret",
  databaseUrl: process.env.DATABASE_URL ?? "",
  redisUrl: process.env.REDIS_URL ?? "",
  platformUserId: process.env.PLATFORM_USER_ID ?? "00000000-0000-0000-0000-000000000001",
  pokemonApiKey: process.env.POKEMON_TCG_API_KEY ?? "",
  pokemonApiBase: process.env.POKEMON_TCG_API_BASE ?? "https://api.pokemontcg.io/v2",
  priceTickSeconds: Number(process.env.PRICE_TICK_SECONDS ?? 45)
};
