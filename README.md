# Omar Hesham — Product Designer

Personal portfolio. Static site: `index.html` + `work/` (project shots) + `img/` (photos). No build step — deploy the repo root on Vercel, Netlify or GitHub Pages.

## Figma → live site sync

Project screenshots in `work/` are pulled automatically from the **Projects** page of the Figma file
(`.github/workflows/sync-figma.yml`, every hour, or instantly via **Actions → Sync from Figma → Run workflow**).
Frames are matched by name — see `figma-sync.json`. Changed images are committed and Vercel redeploys.

Setup (once): add a Figma personal access token (scope: *File content — read*) as the repository secret `FIGMA_TOKEN`.
