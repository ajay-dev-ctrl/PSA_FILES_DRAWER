import { createClient } from "redis";

const queueName = process.env.JOB_QUEUE_NAME ?? "data-jobs";

export const redis = createClient({
  url: process.env.REDIS_URL
});

redis.on("error", (error) => {
  console.error("Redis error", error);
});

export async function enqueueJob(job) {
  await redis.rPush(queueName, JSON.stringify({ id: job.id }));
}
