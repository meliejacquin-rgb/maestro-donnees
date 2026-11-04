#!/usr/bin/env node
// Collecte mensuelle des repères sectoriels publics → references.json + rapport-collecte.json
// Usage : node scripts/collect.mjs [--offline]
//   --offline : n'interroge aucune API (reconstruit depuis data/manuel.json et l'ancien fichier).
// Aucune donnée client n'est lue ni envoyée : uniquement des statistiques publiques.
import { readFile, writeFile } from 'node:fs/promises';
import { parseMelodiCatalog, discover, normalizeMelodiData, computeBranchRatio, parseDatagouv, build, validate, parseBdmSeries, buildDefaillances, buildSalaires } from './lib.mjs';

const ROOT = new URL('../', import.meta.url);
const read = async (p, fallback) => { try { return JSON.parse(await readFile(new URL(p, ROOT), 'utf8')); } catch (e) { if (fallback !== undefined) return fallback; throw e; } };
const offline = process.argv.includes('--offline');

async function get(url, { headers = {}, timeout = 20000, tries = 3 } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeout);
    try {
      const res = await fetch(url, { signal: abort.signal, headers: { Accept: 'application/json', 'User-Agent': 'maestro-donnees (GitHub Actions)', ...headers } });
      if (res.status === 429 || res.status >= 500) throw new Error('HTTP ' + res.status);
      if (!res.ok) { const e = new Error('HTTP ' + res.status); e.fatal = true; throw e; }
      return await res.json();
    } catch (e) {
      last = e.name === 'AbortError' ? new Error('délai dépassé') : e;
      if (last.fatal) break;
      await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
    } finally { clearTimeout(timer); }
  }
  throw last;
}

const naf = await read('naf.json');
const priorites = await read('config/priorites.json');
const sources = await read('config/sources.json');
const manuel = (await read('data/manuel.json')).indicateurs;
const previous = await read('references.json', null);

const report = { date: new Date().toISOString(), mode: offline ? 'hors ligne' : 'en ligne', sources: {}, decouverte: [], avertissements: [] };
const auto = {};
const failed = [];
let liens = null;

if (!offline) {
  // 1. INSEE Melodi : découverte du catalogue + extraction des jeux configurés.
  try {
    const catalog = parseMelodiCatalog(await get(sources.melodi.base + '/catalog/all', { timeout: 60000 }));
    report.decouverte = discover(catalog, sources.melodi.decouverte_mots_cles);
    report.sources.melodi_catalogue = { ok: true, jeux: catalog.length, candidats: report.decouverte.length };
    report.catalogue = catalog.map((d) => d.id + ' — ' + d.titre);
  } catch (e) {
    report.sources.melodi_catalogue = { ok: false, erreur: String(e.message || e) };
  }
  // Inspection : structure réelle de quelques jeux (dimensions, codes, exemples) pour configurer l'extraction.
  report.inspection = {};
  for (const id of sources.melodi.inspecter || []) {
    const out = {};
    try {
      const json = await get(`${sources.melodi.base}/data/${encodeURIComponent(id)}?maxResult=5`, { timeout: 60000, tries: 2 });
      out.exemples = (json.observations || []).slice(0, 5);
      out.cles = Object.keys(json).filter((k) => k !== 'observations');
      out.total = json.paging?.count ?? json.totalCount ?? null;
    } catch (e) { out.erreur_data = String(e.message || e); }
    try {
      const range = await get(`${sources.melodi.base}/range/${encodeURIComponent(id)}`, { timeout: 60000, tries: 2 });
      out.dimensions = JSON.stringify(range).slice(0, 25000);
    } catch (e) { out.erreur_range = String(e.message || e); }
    report.inspection[id] = out;
  }
  // Ratios sectoriels calculés à partir des comptes nationaux par branche.
  const cache = new Map();
  async function melodiAll(dataset, filters) {
    const key = dataset + JSON.stringify(filters);
    if (cache.has(key)) return cache.get(key);
    const obs = [];
    const size = 10000;
    for (let page = 1; page <= 60; page++) {
      const json = await get(`${sources.melodi.base}/data/${encodeURIComponent(dataset)}?${new URLSearchParams({ maxResult: String(size), ...filters, page: String(page) })}`, { timeout: 90000 });
      const got = json.observations || [];
      obs.push(...got);
      if (page === 1) report.pagination_exemple = json.paging ?? null;
      if (got.length < size) break;
      if (page === 60) throw new Error('plus de 600 000 observations : filtres insuffisants');
    }
    cache.set(key, obs);
    return obs;
  }
  for (const cfg of sources.melodi.ratios || []) {
    const origine = 'api:melodi:' + cfg.dataset + ':' + cfg.indicateur;
    try {
      const num = await melodiAll(cfg.dataset, { ...cfg.filtres, ...cfg.numerateur });
      const den = cfg.croissance ? [] : await melodiAll(cfg.dataset, { ...cfg.filtres, ...cfg.denominateur });
      const { entries, doublons, doublon_exemple, non_reconnus } = computeBranchRatio(num, den, { ...cfg, annee_min: new Date().getUTCFullYear() - 5 }, naf);
      if (!entries.length) throw new Error(`aucune valeur exploitable (${num.length} obs. numérateur, ${den.length} obs. dénominateur, ${doublons} doublons)`);
      auto[origine] = entries;
      const periodes = [...new Set(entries.map((e) => e.periode))].sort();
      report.sources[origine] = { ok: true, valeurs: entries.length, periodes, doublons_ecartes: doublons, doublon_exemple, branches_non_reconnues: non_reconnus, obs: [num.length, den.length] };
    } catch (e) {
      failed.push(origine);
      report.sources[origine] = { ok: false, erreur: String(e.message || e), conserve: 'valeurs précédentes' };
    }
  }

  for (const cfg of sources.melodi.jeux) {
    const origine = 'api:melodi:' + cfg.dataset;
    try {
      const params = new URLSearchParams({ maxResult: '100000', ...(cfg.filtres || {}) });
      const json = await get(`${sources.melodi.base}/data/${encodeURIComponent(cfg.dataset)}?${params}`, { timeout: 90000 });
      const { entries, ignored } = normalizeMelodiData(json, cfg, naf);
      if (!entries.length) throw new Error('aucune observation exploitable');
      auto[origine] = entries;
      report.sources[origine] = { ok: true, valeurs: entries.length, ignorees: ignored };
    } catch (e) {
      failed.push(origine);
      report.sources[origine] = { ok: false, erreur: String(e.message || e), conserve: 'valeurs précédentes' };
    }
  }

  // 2. data.gouv.fr : liens de documentation par priorité (jamais des valeurs de comparaison).
  liens = {};
  let ok = 0;
  for (const [prio, q] of Object.entries(sources.datagouv.recherches)) {
    try {
      liens[prio] = parseDatagouv(await get(`${sources.datagouv.base}?page_size=5&q=${encodeURIComponent(q)}`));
      ok++;
    } catch (e) {
      liens[prio] = previous?.liens?.[prio] || [];
      report.avertissements.push(`data.gouv.fr (${prio}) : ${e.message || e}`);
    }
  }
  report.sources.datagouv = { ok: ok > 0, recherches_reussies: ok, total: Object.keys(sources.datagouv.recherches).length };
  if (!ok) liens = null;

  // 2 bis. Défaillances d'entreprises par grand secteur (base BDM de l'INSEE, cumul 12 mois glissants).
  const def = sources.bdm?.defaillances;
  if (def) {
    try {
      const abort = new AbortController(); const timer = setTimeout(() => abort.abort(), 120000);
      const res = await fetch(`https://bdm.insee.fr/series/sdmx/data/${def.flux}?lastNObservations=13`, { signal: abort.signal, headers: { 'User-Agent': 'maestro-donnees (GitHub Actions)' } });
      clearTimeout(timer);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const entries = buildDefaillances(parseBdmSeries(await res.text()), def);
      if (!entries.length) throw new Error('aucune série reconnue');
      auto[def.origine] = entries;
      report.sources[def.origine] = { ok: true, valeurs: entries.length, periode: entries[0].periode };
    } catch (e) {
      failed.push(def.origine);
      report.sources[def.origine] = { ok: false, erreur: String(e.message || e) };
    }
  }

  // 2 ter. Salaire brut moyen par salarié et par secteur (URSSAF, open.urssaf.fr, données annuelles).
  const sal = sources.urssaf?.salaires;
  if (sal) {
    try {
      const json = await get(sal.url_api, { timeout: 60000 });
      const entries = buildSalaires(json.results || [], sal, naf);
      if (entries.length < 50) throw new Error(`seulement ${entries.length} secteurs reconnus`);
      auto[sal.origine] = entries;
      report.sources[sal.origine] = { ok: true, valeurs: entries.length, periode: entries[0].periode };
    } catch (e) {
      failed.push(sal.origine);
      report.sources[sal.origine] = { ok: false, erreur: String(e.message || e) };
    }
  }

  // Exploration BDM (configuration de nouvelles séries) : flux dont le nom contient un mot-clé, et séries d'un flux.
  const explo = sources.bdm?.explorer;
  if (explo) {
    report.exploration_bdm = {};
    const txt = async (url) => { const ab = new AbortController(); const t = setTimeout(() => ab.abort(), 120000); try { const r = await fetch(url, { signal: ab.signal, headers: { 'User-Agent': 'maestro-donnees (GitHub Actions)' } }); return r.ok ? await r.text() : 'HTTP ' + r.status; } finally { clearTimeout(t); } };
    try {
      const xml = await txt('https://bdm.insee.fr/series/sdmx/dataflow/FR1');
      const flux = [...xml.matchAll(/<str:Dataflow[^>]*id="([^"]+)"[\s\S]*?<com:Name xml:lang="fr">([^<]*)</g)].map((m) => m[1] + ' — ' + m[2]);
      report.exploration_bdm.flux = flux.filter((f) => (explo.mots_cles || []).some((k) => f.toLowerCase().includes(k)));
    } catch (e) { report.exploration_bdm.flux_erreur = String(e.message || e); }
    for (const f of explo.flux || []) {
      try {
        const series = parseBdmSeries(await txt(`https://bdm.insee.fr/series/sdmx/data/${f}?lastNObservations=6`));
        report.exploration_bdm[f] = series.filter((x) => (explo.titre_contient || []).some((k) => String(x.TITLE_FR || '').includes(k))).slice(0, 40)
          .map((x) => ({ idbank: x.IDBANK, titre: x.TITLE_FR, obs: x.obs }));
      } catch (e) { report.exploration_bdm[f] = 'erreur : ' + (e.message || e); }
    }
  }

  // 3. Banque de France : seulement si une clé et des séries sont configurées.
  if (!process.env.BDF_API_KEY || !sources.banque_de_france.series.length) {
    report.sources.banque_de_france = { ok: false, erreur: 'non configurée (secret BDF_API_KEY ou séries absents)' };
  }
}

const refs = build({ manuel, auto, liens, previous, failed, now: report.date, naf, priorites });
const errors = validate(refs);
report.validation = errors.length ? errors : 'ok';
report.total_indicateurs = refs.indicateurs.length;
report.a_verifier = refs.indicateurs.filter((e) => e.statut === 'a_verifier').length;

await writeFile(new URL('rapport-collecte.json', ROOT), JSON.stringify(report, null, 2) + '\n');
if (errors.length) {
  console.error('references.json NON publié — erreurs de validation :\n- ' + errors.join('\n- '));
  process.exit(1);
}
await writeFile(new URL('references.json', ROOT), JSON.stringify(refs, null, 1) + '\n');
console.log(`references.json : ${refs.indicateurs.length} repères (${report.a_verifier} à vérifier).`);
for (const [k, v] of Object.entries(report.sources)) console.log(`  ${v.ok ? '✓' : '✗'} ${k}${v.erreur ? ' — ' + v.erreur : ''}`);
if (report.decouverte.length) console.log(`  ${report.decouverte.length} jeux INSEE candidats listés dans rapport-collecte.json`);
