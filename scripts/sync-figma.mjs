// Figma → live site sync. Runs in GitHub Actions (see .github/workflows/sync-figma.yml).
//
// What it syncs from the Figma file:
//   1. Project screens  – frames on the "Projects" page, matched by frame NAME  → work/*.webp
//   2. Text             – text layers in the v4 design frames (Work, About, Experience, Projects).
//                         Each layer is linked to the exact sentence it shows on the site; when you
//                         edit that layer in Figma, the same sentence is replaced in index.html.
//   3. Photos           – the About portrait and the 10 "Outside work" photos. Replace the image
//                         fill in Figma and the site picks up the new photo.
//
// Layout, colours, spacing and new sections are code changes and are NOT synced.
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import sharp from 'sharp';

const CFG_PATH = new URL('../figma-sync.json', import.meta.url);
const SITE = new URL('../index.html', import.meta.url);
const cfg = JSON.parse(await fs.readFile(CFG_PATH, 'utf8'));
const TOKEN = process.env.FIGMA_TOKEN;
if (!TOKEN) {
  console.log('::warning::FIGMA_TOKEN secret is not set yet — nothing synced. Add it in GitHub → Settings → Secrets and variables → Actions.');
  process.exit(0);
}
const api = async (path) => {
  const r = await fetch(`https://api.figma.com/v1/${path}`, { headers: { 'X-Figma-Token': TOKEN } });
  if (!r.ok) throw new Error(`${path} → ${r.status} ${await r.text()}`);
  return r.json();
};
const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');
const log = [];

/* ---------- 1. Project screens ---------- */
{
  const page = await api(`files/${cfg.fileKey}/nodes?ids=${encodeURIComponent(cfg.projectsPageId)}&depth=1`);
  const kids = page.nodes[cfg.projectsPageId].document.children;
  const targets = [];
  for (const [name, file] of Object.entries(cfg.frames)) {
    const node = kids.find((n) => n.name === name);
    if (!node) { console.warn(`! No frame named "${name}" on the Projects page — skipped`); continue; }
    const w = node.absoluteBoundingBox?.width || cfg.width;
    targets.push({ name, file, id: node.id, scale: Math.min(4, cfg.width / w) });
  }
  const groups = Object.groupBy(targets, (t) => t.scale.toFixed(4));
  for (const [scale, list] of Object.entries(groups)) {
    const ids = list.map((t) => t.id).join(',');
    const { images } = await api(`images/${cfg.fileKey}?ids=${encodeURIComponent(ids)}&format=png&scale=${scale}`);
    for (const t of list) {
      const url = images[t.id]; if (!url) { console.warn(`! Export failed for ${t.name}`); continue; }
      const png = Buffer.from(await (await fetch(url)).arrayBuffer());
      // fingerprint the Figma render itself, so re-encoding never causes a false "change"
      const fp = md5(png);
      cfg.frameFingerprints ??= {};
      if (cfg.frameFingerprints[t.file] === fp) continue;
      const first = cfg.frameFingerprints[t.file] === undefined;
      cfg.frameFingerprints[t.file] = fp;
      if (first) continue; // first run only records the baseline
      const webp = await sharp(png).resize({ width: cfg.width }).webp({ quality: 82 }).toBuffer();
      await fs.writeFile(new URL(`../work/${t.file}.webp`, import.meta.url), webp);
      log.push(`screen: ${t.name}`);
    }
  }
}

/* ---------- 2. Text ---------- */
{
  let html = await fs.readFile(SITE, 'utf8');
  const scriptRanges = [...html.matchAll(/<script>[\s\S]*?<\/script>/g)].map((m) => [m.index, m.index + m[0].length]);
  const inScript = (i) => scriptRanges.some(([a, b]) => i >= a && i < b);
  // A layer is only linked to text that fills a whole element (>…<) or a whole JS string ('…'),
  // so a short word can never be swapped inside a longer one.
  // (also safe inside the JS template strings that build the Projects page)
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/`/g, '&#96;').replace(/\$\{/g, '$&#123;');
  const forms = {
    html: (s) => '>' + esc(s).replace(/\n/g, '<br>') + '<',
    js: (s) => "'" + s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, ' ') + "'",
    // "Senior Product Designer · B2B …" → first dot is the accent-coloured <b>·</b>
    eyebrow: (s) => '>' + esc(s).replace(' · ', ' <b>·</b> ') + '<',
    // "OMAR\nHESHAM" → one animated line per row
    name: (s) => s.split('\n').map((l) => `<span><i>${esc(l)}</i></span>`).join(''),
    // "Design with intention." / "LET'S BUILD\nSOMETHING real." → last words in the italic accent
    em1: (s) => emTail(s, 1), em2: (s) => emTail(s, 2), em3: (s) => emTail(s, 3),
  };
  function emTail(s, k) {
    const w = esc(s).replace(/\n/g, '<br>').split(' ');
    if (w.length <= k) return null;
    return '>' + w.slice(0, -k).join(' ') + ' <em>' + w.slice(-k).join(' ') + '</em><';
  }
  const count = (hay, needle) => hay.split(needle).length - 1;
  // find a candidate on the site exactly once (optionally ignoring letter case, for titles that
  // are typed in capitals in Figma but shown in capitals by CSS on the site)
  function locate(cand, ci) {
    if (!cand) return null;
    if (!ci) return count(html, cand) === 1 ? cand : null;
    const H = html.toLowerCase(), c = cand.toLowerCase();
    if (count(H, c) !== 1) return null;
    const i = H.indexOf(c);
    return html.slice(i, i + cand.length);
  }

  const doc = await api(`files/${cfg.fileKey}/nodes?ids=${encodeURIComponent(cfg.textFrames.join(','))}`);
  const texts = [];
  const walk = (n) => {
    if (n.visible === false) return;
    if (n.type === 'TEXT' && n.characters?.trim()) texts.push([n.id, n.characters]);
    (n.children || []).forEach(walk);
  };
  for (const id of cfg.textFrames) walk(doc.nodes[id].document);

  cfg.texts ??= {}; // { nodeId: { last: "text in Figma at last sync", site: "exact string in index.html", form } }
  for (const [id, chars] of texts) {
    const link = cfg.texts[id];
    if (!link) {
      // New layer: link it if its text appears exactly once on the site (in HTML, or inside the JS data).
      const tries = [['html', 0], ['js', 0], ['eyebrow', 0], ['html', 1], ['name', 1], ['em1', 1], ['em2', 1], ['em3', 1]];
      for (const [form, ci] of tries) {
        const site = locate(forms[form](chars), ci);
        if (site && (form !== 'js' || inScript(html.indexOf(site)))) {
          cfg.texts[id] = { last: chars, site, form };
          break;
        }
      }
      continue;
    }
    if (chars === link.last) continue;
    const next = forms[link.form](chars);
    if (!next) { console.warn(`! "${chars.slice(0, 40)}" no longer fits its style on the site — not changed`); continue; }
    const n = count(html, link.site);
    if (n !== 1) { console.warn(`! "${link.site.slice(0, 50)}" found ${n}× on the site — not changed`); continue; }
    html = html.replace(link.site, () => next);
    // keep every Figma layer that pointed at the same sentence linked to the new one
    for (const other of Object.values(cfg.texts)) if (other.site === link.site) other.site = next;
    link.last = chars;
    log.push(`text: "${chars.slice(0, 40)}"`);
  }
  await fs.writeFile(SITE, html);
}

/* ---------- 3. Photos ---------- */
{
  const ids = Object.keys(cfg.photos);
  const doc = await api(`files/${cfg.fileKey}/nodes?ids=${encodeURIComponent(ids.join(','))}&depth=1`);
  let fills = null;
  for (const id of ids) {
    const p = cfg.photos[id];
    const ref = doc.nodes[id]?.document?.fills?.find((f) => f.type === 'IMAGE')?.imageRef;
    if (!ref || ref === p.ref) continue;
    fills ??= (await api(`files/${cfg.fileKey}/images`)).meta.images;
    const url = fills[ref]; if (!url) { console.warn(`! No image URL for ${p.file}`); continue; }
    const img = Buffer.from(await (await fetch(url)).arrayBuffer());
    const out = await sharp(img).rotate().resize({ width: p.width, withoutEnlargement: true }).webp({ quality: 84 }).toBuffer();
    await fs.writeFile(new URL(`../${p.file}`, import.meta.url), out);
    p.ref = ref;
    log.push(`photo: ${p.file}`);
  }
}

await fs.writeFile(CFG_PATH, JSON.stringify(cfg, null, 2) + '\n');
console.log(log.length ? `Updated from Figma:\n- ${log.join('\n- ')}` : 'No changes in Figma');
await fs.writeFile(new URL('../.sync-summary', import.meta.url), log.join('; ').slice(0, 200));
