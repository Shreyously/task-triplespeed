import { Router } from "express";
import { loginController, meController, signupController } from "../../controllers/authController";
import { validateBody } from "../../middleware/validate";
import { loginSchema, signupSchema } from "@pullvault/common";
import { authMiddleware } from "../../middleware/auth";
import { asyncHandler } from "../../middleware/async";

export const authRoutes = Router();
authRoutes.post("/signup", validateBody(signupSchema), asyncHandler(signupController));
authRoutes.post("/login", validateBody(loginSchema), asyncHandler(loginController));
authRoutes.get("/me", authMiddleware, asyncHandler(meController));
