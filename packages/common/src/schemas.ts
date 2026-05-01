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
  price: z.string()
});

export const buyListingSchema = z.object({
  idempotencyKey: z.string().min(8).optional()
});

export const createAuctionSchema = z.object({
  cardId: z.string().uuid(),
  durationSeconds: z.number().int().refine((v) => [60,300,900].includes(v), "Invalid duration")
});

export const placeBidSchema = z.object({
  amount: z.string(),
  idempotencyKey: z.string().min(8).optional()
});
