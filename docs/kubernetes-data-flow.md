# Kubernetes Data Processing

The Docker Compose setup maps cleanly to Kubernetes. Each container becomes a workload, and the data-processing path stays the same.

## Runtime Flow

```text
Internet
  -> Ingress
  -> frontend Service
  -> frontend Pods

Browser API calls
  -> Ingress
  -> api Service
  -> api Pods
  -> Redis queue
  -> worker Pods
  -> PostgreSQL
```

## Components

- `frontend Deployment`: serves the React application.
- `api Deployment`: receives requests, validates payloads, writes initial job rows, and enqueues work.
- `worker Deployment`: consumes Redis jobs, processes payloads, and updates job records.
- `Redis`: queue between API and workers.
- `PostgreSQL`: durable job state and processing results.
- `ConfigMap`: non-secret service configuration.
- `Secret`: database URL, Redis URL, credentials, and API keys.

## Scaling Model

The API and worker scale separately.

```bash
kubectl scale deployment/api --replicas=3
kubectl scale deployment/worker --replicas=5
```

For production, worker scaling should be driven by queue depth using KEDA or another autoscaler.

## Production Notes

- Prefer managed Postgres and managed Redis for production.
- Keep only stateless app containers in Kubernetes where possible.
- Use readiness and liveness probes for API and frontend.
- Use migrations instead of raw `init.sql` once the schema starts evolving.
- Use Kubernetes Secrets or an external secret manager for credentials.
