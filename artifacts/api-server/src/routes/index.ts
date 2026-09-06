import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import bidsRouter from "./bids";
import settingsRouter from "./settings";
import matchesRouter from "./matches";
import scansRouter from "./scans";
import { requireAuth } from "../lib/auth";

const router: IRouter = Router();

// 공개: 헬스체크 + 로그인 관련 엔드포인트 (로그인 여부를 확인해야 하니 /auth/me도 공개).
router.use(healthRouter);
router.use(authRouter);

// 이 아래는 전부 로그인 필요.
router.use(requireAuth);
router.use(bidsRouter);
router.use(settingsRouter);
router.use(matchesRouter);
router.use(scansRouter);

export default router;
