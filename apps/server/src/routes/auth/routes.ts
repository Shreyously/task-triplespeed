import { Router } from "express";
import { loginController, meController, signupController } from "../../controllers/authController";
import { validateBody } from "../../middleware/validate";
import { loginSchema, signupSchema } from "@pullvault/common";
import { authMiddleware } from "../../middleware/auth";
import { asyncHandler } from "../../middleware/async";
import { rateLimitMiddleware } from "../../middleware/rateLimit";

export const authRoutes = Router();
authRoutes.post("/signup", rateLimitMiddleware('AUTH'), validateBody(signupSchema), asyncHandler(signupController));
authRoutes.post("/login", rateLimitMiddleware('AUTH'), validateBody(loginSchema), asyncHandler(loginController));
authRoutes.get("/me", authMiddleware, rateLimitMiddleware('API'), asyncHandler(meController));
