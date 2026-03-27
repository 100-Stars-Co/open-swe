/**
 * Main Hono application.
 * Mounts all webhook routes and the health check endpoint.
 */

import { Hono } from "hono";
import { githubRoutes } from "./routes/github.ts";
import { slackRoutes } from "./routes/slack.ts";
import { linearRoutes } from "./routes/linear.ts";

const app = new Hono();

// Health check
app.get("/health", (c) => c.json({ status: "healthy" }));

// Webhook routes
app.route("/webhooks/github", githubRoutes);
app.route("/webhooks/slack", slackRoutes);
app.route("/webhooks/linear", linearRoutes);

export { app };
