// Pulls the project frames from the Figma "Projects" page and refreshes work/*.webp.
// Frames are matched by NAME (see figma-sync.json), so replacing a frame in Figma is fine
// as long as the new frame keeps the same name.
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import sharp from 'sharp';

const cfg = JSON.parse(await fs.readFile(new URL('../figma-sync.json', import.meta.url)));
const TOKEN = process.env.FIGMA_TOKEN;
if (!TOKEN) { console.error('FIGMA_TOKEN secret is missing'); process.exit(1); }
const api = async (path) => {
  const r = await fetch(`https://api.figma.com/v1/${path}`, { headers: { 'X-Figma-Token': TOKEN } });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
};

// 1. Find current frame ids on the Projects page by name
const page = await api(`files/${cfg.fileKey}/nodes?ids=${encodeURIComponent(cfg.projectsPageId)}&depth=1`);
const kids = page.nodes[cfg.projectsPageId].document.children;
const targets = [];
for (const [name, file] of Object.entries(cfg.frames)) {
  const node = kids.find(n => n.name === name);
  if (!node) { console.warn(`! No frame named "${name}" on the Projects page — skipped`); continue; }
  const w = node.absoluteBoundingBox?.width || cfg.width;
  targets.push({ name, file, id: node.id, scale: Math.min(4, cfg.width / w) });
}

// 2. Export (grouped by scale) and 3. write only what changed
let changed = 0;
const groups = Object.groupBy(targets, t => t.scale.toFixed(4));
for (const [scale, list] of Object.entries(groups)) {
  const ids = list.map(t => t.id).join(',');
  const { images } = await api(`images/${cfg.fileKey}?ids=${encodeURIComponent(ids)}&format=png&scale=${scale}`);
  for (const t of list) {
    const url = images[t.id]; if (!url) { console.warn(`! Export failed for ${t.name}`); continue; }
    const png = Buffer.from(await (await fetch(url)).arrayBuffer());
    const webp = await sharp(png).resize({ width: cfg.width, withoutEnlargement: false }).webp({ quality: 82 }).toBuffer();
    const out = `work/${t.file}.webp`;
    const old = await fs.readFile(out).catch(() => null);
    const same = old && crypto.createHash('md5').update(old).digest('hex') === crypto.createHash('md5').update(webp).digest('hex');
    if (!same) { await fs.writeFile(out, webp); changed++; console.log(`✓ updated ${out} (${t.name})`); }
  }
}
console.log(changed ? `${changed} image(s) updated` : 'No changes');
