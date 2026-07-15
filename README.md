# fabee-session-api

Cluster-internal session, ACL, history, audit, and artifact API for Fabee Shared Desk. It evolves the former `fabee-log-read-api` service and uses the existing `fabee-pi-agent` PVC; no second API or database is required.

## Security

Every endpoint except `GET /health` requires the internal bearer token. `bee-web` is the only intended caller and passes the email verified by oauth2-proxy as `actorEmail`. The browser must never call this service directly. Unauthorized access to a session or artifact returns `404`.

Only normalized `@jobmatch.me` identities are accepted. New sessions use opaque `ses_<uuid>` IDs and are permanently bound to `fabee-pi-agent`, route `fabee`, and transport `web`.

## Configuration

```sh
READ_API_BEARER_TOKEN=change-me
READ_API_HOST=0.0.0.0
READ_API_PORT=8080
READ_API_RUN_LOG_DIR=/workspace/.fabee-pi-agent/logs
READ_API_SESSION_DIR=/workspace/.fabee-pi-agent/sessions
READ_API_ARTIFACT_DIR=/workspace/.bee-blob-store
```

The `READ_API_*` environment names remain compatible with the previous sidecar deployment.

## API

All session routes below require `Authorization: Bearer <token>`.

- `GET /health`
- `POST /sessions` — `{ "owner": "alice@jobmatch.me" }`
- `GET /sessions?actorEmail=alice@jobmatch.me&limit=50` — returns `{ owned, shared }`
- `GET /sessions/:sessionId?actorEmail=alice@jobmatch.me`
- `GET /sessions/:sessionId/runs?actorEmail=alice@jobmatch.me`
- `GET /sessions/:sessionId/capabilities?actorEmail=alice@jobmatch.me[&runActorEmail=bob@jobmatch.me]`
- `PUT /sessions/:sessionId/collaborators` — `{ "actorEmail": "owner@jobmatch.me", "collaborators": ["bob@jobmatch.me"] }`
- `POST /sessions/:sessionId/archive` — `{ "actorEmail": "owner@jobmatch.me" }`
- `GET /sessions/:sessionId/artifacts/:artifactId?actorEmail=alice@jobmatch.me`

Responses include server-derived `role` and `permissions`. Collaborator changes and archive actions append to `audit.jsonl`; metadata replacement is atomic. Artifact downloads resolve only persisted `artifact.created` blob keys inside the configured blob-store root.

The previous user-key listing/detail routes remain temporarily available for legacy web history until the explicit rollout cleanup.

## Development

```sh
npm install
npm run check
npm start
```

```sh
docker build -t ghcr.io/jobmatchme/fabee-session-api:0.1.2 .
```
