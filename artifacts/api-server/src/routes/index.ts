import { Router, type IRouter } from "express";
import healthRouter from "./health";
import bidsRouter from "./bids";

const router: IRouter = Router();

router.use(healthRouter);
router.use(bidsRouter);

export default router;
