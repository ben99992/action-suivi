// Builds progress.json from taches.json (tasks and dependencies taken from the plans),
// the SDD controller ledgers (.superpowers/sdd/<plan>/progress.md + brief/report/review files)
// and git, then commits and pushes the "suivi" branch when anything changed.
// Run: node sync.mjs [--no-commit]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SUIVI = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(SUIVI, '..');
const SDD = path.join(REPO, '.superpowers', 'sdd');
const OUT = path.join(SUIVI, 'progress.json');
const REF = path.join(SUIVI, 'reference.json');
const LOCK = path.join(SUIVI, '.sync.lock');
const LOG = path.join(SUIVI, 'sync.log');
const NO_COMMIT = process.argv.includes('--no-commit');

function log(msg) {
  fs.appendFileSync(LOG, `${new Date().toISOString()} ${msg}\n`);
}

function git(args, cwd = REPO) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

const dateCache = new Map();
function commitDate(hash) {
  if (!hash) return null;
  if (!dateCache.has(hash)) {
    try { dateCache.set(hash, new Date(git(['show', '-s', '--format=%cI', hash])).toISOString()); }
    catch { dateCache.set(hash, null); }
  }
  return dateCache.get(hash);
}

function mtime(file) {
  try { return fs.statSync(file).mtime.toISOString(); } catch { return null; }
}

function maxIso(...values) {
  return values.filter(Boolean).sort().pop() ?? null;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---- per-plan ledger -------------------------------------------------------

function readPlan(dir) {
  const base = path.join(SDD, dir);
  const ledgerPath = path.join(base, 'progress.md');
  const lines = fs.existsSync(ledgerPath) ? fs.readFileSync(ledgerPath, 'utf8').split(/\r?\n/) : [];
  const files = fs.existsSync(base) ? fs.readdirSync(base) : [];
  const reviews = files
    .filter((f) => /^review-\w+\.\.\w+\.diff$/.test(f))
    .map((f) => ({ file: f, end: f.match(/\.\.(\w+)\.diff$/)[1], at: mtime(path.join(base, f)) }));
  return { base, lines, files, reviews };
}

function find(lines, re) {
  for (const line of lines) {
    const m = line.match(re);
    if (m) return m;
  }
  return null;
}

// State of one task from its plan's ledger. Returns null when the ledger says nothing.
function ledgerState(task, plan) {
  const at = (f) => mtime(path.join(plan.base, f));

  if (task.tache === 'final') {
    const done = find(plan.lines, /^- Final fix wave: commits (\w+)\.\.(\w+)/);
    const review = find(plan.lines, /^- Final review \((\w+)\)/);
    if (done) {
      return {
        statut: 'fait', avancement: 100, commit: done[2],
        debut: commitDate(review?.[1] ?? done[1]), fin: commitDate(done[2]),
        note: 'Revue finale puis corrections, re-revue sans point bloquant',
      };
    }
    if (review) {
      const fixing = plan.files.includes('final-fix-brief.md');
      return {
        statut: 'en cours', avancement: fixing ? 70 : 40, commit: review[1],
        debut: commitDate(review[1]), fin: null,
        note: fixing ? 'Corrections de la revue finale en cours' : 'Revue finale en cours',
        jalons: fixing ? [{ t: at('final-fix-brief.md'), texte: 'Corrections de la revue finale lancées' }] : [],
      };
    }
    return null;
  }

  const n = task.tache;
  const completeRe = task.registre
    ? new RegExp(task.registre)
    : new RegExp(`^- Task ${escapeRe(n)}: complete \\(commits (\\w+)\\.\\.(\\w+)(.*)$`);
  const brief = task.brief ?? `task-${n}-brief.md`;
  const report = task.rapport ?? `task-${n}-report.md`;
  const briefAt = plan.files.includes(brief) ? at(brief) : null;
  const done = find(plan.lines, completeRe);
  if (done) {
    const rounds = (done[3] ?? '').match(/after (\d+) fix round/);
    return {
      statut: 'fait', avancement: 100, commit: done[2],
      debut: briefAt ?? commitDate(done[1]), fin: commitDate(done[2]),
      note: rounds ? `Revue sans réserve après ${rounds[1]} correction(s)` : 'Revue sans réserve',
    };
  }

  if (!/^\d+$/.test(n)) return briefAt ? { statut: 'en cours', avancement: 15, debut: briefAt, fin: null, commit: null, note: 'Commencé' } : null;

  const userParts = find(plan.lines, /^- Tasks (\d+)-(\d+) \(non-user parts\): complete \(commits (\w+)\.\.(\w+)/);
  const blocked = find(plan.lines, new RegExp(`^- Task ${n}: .*BLOCKED(.*)$`));
  if (userParts && +n >= +userParts[1] && +n <= +userParts[2]) {
    return {
      statut: 'en cours', avancement: 50, commit: userParts[4], debut: briefAt ?? commitDate(userParts[3]), fin: null,
      note: 'Partie code terminée, étapes de l\'utilisateur en attente', partiel: true,
    };
  }
  if (!briefAt) return null;
  if (blocked) {
    return { statut: 'bloqué', avancement: 0, debut: briefAt, fin: null, commit: null, note: `Bloqué${blocked[1] ? ' :' + blocked[1] : ''}`.trim() };
  }

  // In progress: honest estimate from the SDD milestones actually reached.
  const reportAt = plan.files.includes(report) ? at(report) : null;
  const delivered = reportAt && reportAt >= briefAt ? reportAt : null;
  const fixes = plan.lines
    .map((l) => l.match(new RegExp(`^- Task ${n}: fix round (\\d+)/5`)))
    .filter(Boolean).map((m) => +m[1]);
  const lastFix = fixes.length ? Math.max(...fixes) : 0;
  const reviewed = delivered && plan.reviews.some((r) => r.at && r.at >= delivered);
  let avancement = 15, note = 'Implémentation en cours';
  const jalons = [{ t: briefAt, texte: 'Implémentation lancée' }];
  if (delivered) { avancement = 60; note = 'Implémentation livrée, revue à venir'; jalons.push({ t: delivered, texte: 'Implémentation livrée' }); }
  if (reviewed) { avancement = 75; note = 'En revue'; }
  if (lastFix) { avancement = Math.min(90, 80 + 5 * (lastFix - 1)); note = `Correction n° ${lastFix} faite, nouvelle revue`; }

  let commit = null;
  try {
    const [hash, date] = git(['log', '-1', '--format=%h|%cI']).split('|');
    if (new Date(date).toISOString() >= briefAt) commit = hash;
  } catch { /* no commit yet */ }
  return { statut: 'en cours', avancement, debut: briefAt, fin: null, commit, note, jalons };
}

function merge(task, derived) {
  const manual = task.manuel;
  if (derived?.statut === 'fait') return derived;
  if (manual?.statut === 'fait') {
    return {
      statut: 'fait', avancement: 100,
      commit: manual.fin_commit ?? derived?.commit ?? null,
      debut: derived?.debut ?? null, fin: commitDate(manual.fin_commit) ?? null,
      note: manual.note,
    };
  }
  if (derived) return derived;
  if (manual?.statut === 'bloqué') {
    return { statut: 'bloqué', avancement: 0, commit: null, debut: null, fin: null, depuis: manual.depuis ? new Date(manual.depuis).toISOString() : null, note: manual.note };
  }
  return { statut: 'à faire', avancement: 0, commit: null, debut: null, fin: null, note: manual?.note ?? '' };
}

// ---- last activity of the agent ----------------------------------------------

function latestMtime(dir, depth, skip = new Set(['node_modules', 'dist', '.expo', '.git', '.pages', '.suivi', '.turbo'])) {
  let best = null;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    if (skip.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (depth > 0) best = maxIso(best, latestMtime(p, depth - 1, skip)); }
    else best = maxIso(best, mtime(p));
  }
  return best;
}

// ---- planned-vs-actual reference (frozen once) ----------------------------------

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null;
}

function ensureReference(tasks) {
  if (fs.existsSync(REF)) return JSON.parse(fs.readFileSync(REF, 'utf8'));
  // Pace = elapsed time since the first task started / tasks done (nights and waits for the user included).
  const done = tasks.filter((t) => t.statut === 'fait' && t.debut && t.fin);
  const first = Math.min(...done.map((t) => +new Date(t.debut)));
  const last = Math.max(...done.map((t) => +new Date(t.fin)));
  const pace = (last - first) / done.length;
  // Sequential schedule in plan order, a blocked task (waiting for the user) going after
  // every task that does not need it, as the controller does.
  const pending = tasks.filter((t) => t.statut !== 'fait' && t.tache !== 'plan');
  const ids = new Set(pending.map((t) => t.id));
  const placed = new Set();
  const order = [];
  while (order.length < pending.length) {
    const ready = pending.filter((t) => !placed.has(t.id) && t.dependances.every((d) => !ids.has(d) || placed.has(d)));
    const next = ready.find((t) => t.statut !== 'bloqué') ?? ready[0];
    if (!next) break;
    placed.add(next.id);
    order.push(next);
  }
  const now = new Date();
  let cursor = now.getTime();
  const fins = {};
  for (const t of order) {
    cursor += pace * (1 - (t.avancement ?? 0) / 100);
    fins[t.id] = new Date(cursor).toISOString();
  }
  const ref = {
    fige_le: now.toISOString(),
    methode: 'Cadence moyenne observée depuis le début du projet (pauses et attentes comprises), tâches restantes enchaînées dans l\'ordre du plan, celles qui attendent l\'utilisateur après les autres. Figée une fois pour toutes. Plans 4 et 5 exclus (pas encore de plan détaillé).',
    minutes_par_tache: Math.round(pace / 60000),
    echantillon: done.length,
    fins_prevues: fins,
  };
  fs.writeFileSync(REF, JSON.stringify(ref, null, 1) + '\n');
  return ref;
}

// ---- build -------------------------------------------------------------------

function build() {
  const def = JSON.parse(fs.readFileSync(path.join(SUIVI, 'taches.json'), 'utf8'));
  const plans = Object.fromEntries(def.phases.filter((p) => p.sdd).map((p) => [p.id, readPlan(p.sdd)]));

  const events = [];
  const tasks = def.taches.map((t) => {
    const plan = plans[t.phase];
    const derived = plan ? ledgerState(t, plan) : null;
    const s = merge(t, derived);
    for (const j of derived?.statut === s.statut ? derived.jalons ?? [] : []) {
      if (j.t && j.t !== s.debut) events.push({ t: j.t, id: t.id, type: 'jalon', texte: j.texte });
    }
    if (s.debut) events.push({ t: s.debut, id: t.id, type: 'debut', texte: 'Commencée' });
    if (s.fin) events.push({ t: s.fin, id: t.id, type: 'fait', texte: 'Terminée' });
    if (s.statut === 'bloqué' && s.depuis) events.push({ t: s.depuis, id: t.id, type: 'bloque', texte: 'Bloquée' });
    return {
      id: t.id, titre: t.titre, phase: t.phase, tache: t.tache,
      statut: s.statut, dependances: t.dependances, avancement: s.avancement,
      date_debut: s.debut ?? null, date_fin: s.fin ?? null, commit: s.commit ?? null, note: s.note ?? '',
    };
  });

  const reference = ensureReference(tasks.map((t) => ({ ...t, debut: t.date_debut, fin: t.date_fin })));
  events.sort((a, b) => (a.t < b.t ? 1 : -1));

  let head = null;
  try { const [h, d] = git(['log', '-1', '--format=%h|%cI']).split('|'); head = { commit: h, date: new Date(d).toISOString() }; } catch { /* empty repo */ }
  const activity = maxIso(
    head?.date,
    latestMtime(SDD, 1),
    latestMtime(path.join(REPO, 'packages'), 4),
    latestMtime(path.join(REPO, 'apps'), 4),
    latestMtime(path.join(REPO, 'docs'), 4),
    latestMtime(path.join(REPO, 'supabase'), 3),
  );

  return {
    projet: def.projet,
    derniere_activite: activity,
    branche: (() => { try { return git(['rev-parse', '--abbrev-ref', 'HEAD']); } catch { return null; } })(),
    dernier_commit: head,
    phases: def.phases.map(({ id, titre }) => ({ id, titre })),
    taches: tasks,
    evenements: events.slice(0, 40),
    reference,
  };
}

function stable(obj) {
  const { genere_le, ...rest } = obj;
  return JSON.stringify(rest);
}

function main() {
  try {
    const fd = fs.openSync(LOCK, 'wx');
    fs.closeSync(fd);
  } catch {
    if (Date.now() - fs.statSync(LOCK).mtimeMs < 5 * 60000) return;
    fs.utimesSync(LOCK, new Date(), new Date());
  }
  try {
    const data = build();
    const previous = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : null;
    if (previous && stable(previous) === stable(data)) return;
    data.genere_le = new Date().toISOString();
    fs.writeFileSync(OUT, JSON.stringify(data, null, 1) + '\n');
    if (NO_COMMIT) return;

    const before = previous ? new Map(previous.taches.map((t) => [t.id, t])) : new Map();
    const changes = data.taches
      .filter((t) => { const p = before.get(t.id); return !p || p.statut !== t.statut || p.avancement !== t.avancement; })
      .map((t) => `${t.id} ${t.statut} ${t.avancement} %`);
    const subject = changes.length
      ? `chore(suivi): ${changes.slice(0, 3).join(', ')}${changes.length > 3 ? ` (+${changes.length - 3})` : ''}`
      : 'chore(suivi): activité';
    git(['add', '-A'], SUIVI);
    git(['commit', '-q', '-m', subject, '-m', 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'], SUIVI);
    log(`commit: ${subject}`);
    if (git(['remote'], SUIVI).split(/\s+/).includes('suivi')) {
      git(['push', '-q', 'suivi', 'suivi:main'], SUIVI);
      log('push ok');
    }
  } catch (e) {
    log(`erreur: ${(e.stderr || e.message || String(e)).toString().trim()}`);
    process.exitCode = 1;
  } finally {
    fs.rmSync(LOCK, { force: true });
  }
}

main();
