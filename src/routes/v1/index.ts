import Elysia from "elysia";
import { authRoutes } from "./auth";
import { memberRoutes } from "./members";
import { dashboardRoutes } from "./dashboard";
import { contributionRoutes } from "./contributions";
import { loanRoutes } from "./loans";
import { dividendRoutes } from "./dividends";
import { messageRoutes } from "./messages";
import { notificationRoutes } from "./notifications";
import { websocketRoutes } from "./websocket";
import { announcementRoutes } from "./announcements";
import { reportRoutes } from "./reports";
import { bankRoutes } from "./banks";
import { webhookRoutes } from "./webhooks";

export const v1Routes = new Elysia({ prefix: "/v1" })
  .use(authRoutes)
  .use(memberRoutes)
  .use(dashboardRoutes)
  .use(contributionRoutes)
  .use(loanRoutes)
  .use(dividendRoutes)
  .use(messageRoutes)
  .use(notificationRoutes)
  .use(websocketRoutes)
  .use(announcementRoutes)
  .use(reportRoutes)
  .use(bankRoutes)
  .use(webhookRoutes);
