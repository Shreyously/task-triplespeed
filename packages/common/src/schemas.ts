import { z } from "zod";

export const signupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8)
});

export const loginSchema = signupSchema;

export const buyPackSchema = z.object({
  dropId: z.string().uuid(),
  idempotencyKey: z.string().min(8).optional()
});

export const createListingSchema = z.object({
  cardId: z.string().uuid(),
  price: z.string().refine(
    (val) => !isNaN(Number(val)) && Number(val) >= 0.01 && Number(val) <= 1000000,
    "Price must be between $0.01 and $1,000,000"
  )
});

export const buyListingSchema = z.object({
  idempotencyKey: z.string().min(8).optional()
});

export const createAuctionSchema = z.object({
  cardId: z.string().uuid(),
  durationSeconds: z.number().int().refine((v) => [60,300,900].includes(v), "Invalid duration")
});

export const placeBidSchema = z.object({
  amount: z.string().refine(
    (val) => !isNaN(Number(val)) && Number(val) > 0,
    "Bid amount must be a positive number"
  ),
  idempotencyKey: z.string().min(8).optional(),
  confirmHighBid: z.boolean().optional()
});

const tierEnum = z.enum(["Basic", "Pro", "Elite"]);
const rarityWeightsSchema = z.record(z.string(), z.number().min(0).max(1));
const customWeightsByTierSchema = z.object({
  Basic: rarityWeightsSchema.optional(),
  Pro: rarityWeightsSchema.optional(),
  Elite: rarityWeightsSchema.optional()
});

export const simulateEconomicsSchema = z.object({
  tier: tierEnum.optional(),
  customWeights: customWeightsByTierSchema.optional(),
  runs: z.number().int().min(100).max(50000).optional()
});

export const rebalanceEconomicsSchema = z.object({
  dryRun: z.boolean().optional(),
  tier: tierEnum.optional()
});
