import pg from "pg";
import { createClient } from "redis";
import { processPayload } from "./processor.js";
import logger from "./logger.js";

const { Pool } = pg;
const queueName = process.env.JOB_QUEUE_NAME ?? "data-jobs";
const pollMs    = Number(process.env.WORKER_POLL_MS ?? 1000);

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const redis = createClient({ url: process.env.REDIS_URL });
redis.on("error", (err) => logger.error({ err }, "Redis client error"));

async function markProcessing(jobId) {
  const result = await pool.query(
    "UPDATE positions SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *",
    ["processing", jobId]
  );
  return result.rows[0] ?? null;
}

async function markCompleted(jobId, result) {
  await pool.query(
    "UPDATE positions SET status = $1, result = $2, error = NULL, updated_at = NOW() WHERE id = $3",
    ["completed", result, jobId]
  );
}

async function markFailed(jobId, error) {
  await pool.query(
    "UPDATE positions SET status = $1, error = $2, updated_at = NOW() WHERE id = $3",
    ["failed", error.message, jobId]
  );
}

async function handleQueueItem(rawItem) {
  const item = JSON.parse(rawItem);
  const job  = await markProcessing(item.id);

  if (!job) {
    logger.warn({ jobId: item.id }, "Skipping missing job");
    return;
  }

  const t0 = Date.now();
  try {
    const result = processPayload(job.payload);
    await markCompleted(job.id, result);
    logger.info({ jobId: job.id, ms: Date.now() - t0 }, "Job completed");
  } catch (err) {
    await markFailed(job.id, err);
    logger.error({ err, jobId: job.id }, "Job failed");
  }
}

async function run() {
  await redis.connect();
  logger.info({ queue: queueName }, "Worker listening");

  while (true) {
    try {
      const item = await redis.blPop(queueName, pollMs / 1000);
      if (item) await handleQueueItem(item.element);
    } catch (err) {
      logger.error({ err }, "Worker poll error — retrying in 2s");
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

async function shutdown(signal) {
  logger.info({ signal }, "Graceful shutdown started");
  await redis.quit().catch(() => {});
  await pool.end().catch(() => {});
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));

run().catch((err) => {
  logger.fatal({ err }, "Worker fatal error");
  process.exit(1);
});
