# KG Explorer

KG Explorer is a static React and G6 portfolio demo for exploring curated, real medical knowledge-graph data. It runs entirely in the browser from the versioned `/demo-data` assets; it does not require or call a backend API.

## Development

```bash
cd frontend
npm ci
npm run dev
```

## Deployment

Vercel builds from the repository root using `vercel.json`:

- Install: `cd frontend && npm ci`
- Build: `cd frontend && npm run build`
- Output: `frontend/dist`

The release package intentionally includes only the frontend source and curated static demo data. It excludes the original KG backend, source imports, local environments, build artifacts, credentials, and Git history.

## Updating this release repository

The working development repository is maintained separately. To publish later changes, copy the reviewed frontend source and `frontend/public/demo-data` into this release repository, run the validation and production build, then commit and push `main`. Vercel deploys the push automatically once the Git integration is connected.
