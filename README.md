# PSA Workflow

Docker-first starter for an API, worker, web UI, PostgreSQL database, and Redis queue.

## Services

- `frontend`: React UI for submitting and viewing data-processing jobs.
- `api`: Node/Express API that accepts jobs and publishes them to Redis.
- `worker`: Node worker that consumes Redis jobs, processes data, and writes results to Postgres.
- `postgres`: Persistent job metadata and results.
- `redis`: Queue used between the API and worker.

## Offline Storage

Every submitted input is saved locally in Postgres before it is queued for processing.

```text
Input payload
  -> memories table
  -> jobs table
  -> Redis queue
  -> worker result back to jobs table
```

The database is stored in the Docker volume `postgres_data`, so it survives normal container restarts.

## Run Locally

```bash
docker compose up --build
```

Open:

- Frontend: <http://localhost:5173>
- API health: <http://localhost:3000/health>

## Data Flow

```text
Browser
  -> API container
  -> Redis queue
  -> Worker container
  -> PostgreSQL
  -> API container
  -> Browser
```

## API

Create a job:

```bash
curl -X POST http://localhost:3000/jobs \
  -H "Content-Type: application/json" \
  -d "{\"payload\":{\"message\":\"hello docker\"}}"
```

List jobs:

```bash
curl http://localhost:3000/jobs
```

Get a job:

```bash
curl http://localhost:3000/jobs/<job-id>
```

## Kubernetes Direction

When this moves to Kubernetes:

- `api`, `worker`, and `frontend` become Deployments.
- `api` and `frontend` get Services.
- Public HTTP traffic enters through an Ingress.
- Postgres and Redis can start in-cluster for development, then move to managed services for production.
- Worker replicas can scale independently based on queue depth.

See [docs/kubernetes-data-flow.md](docs/kubernetes-data-flow.md).

## Access

This system is admin-only — there is no public self-registration. Log in at
<http://localhost:5173/login.html> with an account created by an admin
(Settings → Create User, once signed in as an existing admin). Credentials
are never committed to this repo; they're issued out-of-band by whoever
manages the deployment.