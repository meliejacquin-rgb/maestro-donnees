// Fonctions pures (testées) : lecture des réponses des API publiques,
// construction et validation de references.json, résolution par secteur.

export const SCHEMA_VERSION = 1;

/** Texte français d'un champ INSEE : "x", [{lang,content}], {fr:"x"} ou {content}. */
export function textFr(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v.trim();
  if (Array.isArray(v)) {
    const fr = v.find((x) => x && (x.lang === 'fr' || x['@lang'] === 'fr'));
    return textFr(fr ?? v[0]);
  }
  if (typeof v === 'object') return textFr(v.content ?? v.fr ?? v.value ?? v['#text'] ?? '');
  return String(v);
}

/** Catalogue Melodi (JSON) → [{id, titre, description, modifie}]. */
export function parseMelodiCatalog(json) {
  const arr = Array.isArray(json) ? json
    : Array.isArray(json?.items) ? json.items
    : Array.isArray(json?.datasets) ? json.datasets
    : Array.isArray(json?.results) ? json.results
    : Array.isArray(json?.data) ? json.data : null;
  if (!arr) throw new Error('Catalogue Melodi : format non reconnu');
  return arr.map((d) => ({
    id: textFr(d.identifier ?? d.id),
    titre: textFr(d.title ?? d.label),
    description: textFr(d.description).slice(0, 400),
    modifie: textFr(d.modified ?? d.issued ?? ''),
  })).filter((d) => d.id);
}

/** Clé de tri d'une période (« fin 2025 », « 2025-T1 », « 2023 ») : année d'abord. */
export const periodKey = (p) => { const s = String(p || ''); const y = s.match(/(19|20)\d{2}/); return (y ? y[0] : '0000') + '|' + s; };

const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Jeux du catalogue dont le titre ou la description contient un mot-clé. */
export function discover(catalog, keywords) {
  const keys = keywords.map(norm);
  return catalog
    .map((d) => ({ ...d, mots_cles: keys.filter((k) => norm(d.titre + ' ' + d.description).includes(k)) }))
    .filter((d) => d.mots_cles.length)
    .sort((a, b) => b.mots_cles.length - a.mots_cles.length)
    .slice(0, 60);
}

/** Code d'activité Melodi → division ("43"), section ("F") ou null. */
export function nafCode(raw, naf) {
  const s = String(raw || '').toUpperCase().trim();
  if (/^(TOTAL|_T|_Z|ENSEMBLE|ALL)$/.test(s)) return '*';
  const candidates = [s, ...s.split(/[_\-.: ]/).reverse()];
  for (const c of candidates) {
    const d = c.replace(/^0?(\d)$/, '0$1');
    if (/^\d{2}$/.test(d) && naf.divisions[d]) return d;
    if (/^[A-U]$/.test(c) && naf.sections[c]) return c;
  }
  return null;
}

/** Données Melodi → entrées d'indicateur (dernière période disponible par code NAF). */
export function normalizeMelodiData(json, cfg, naf) {
  const obs = Array.isArray(json?.observations) ? json.observations : null;
  if (!obs) throw new Error('Données Melodi : tableau « observations » absent');
  const best = new Map();
  let ignored = 0;
  for (const o of obs) {
    const dims = o.dimensions || {};
    if (Object.entries(cfg.filtres || {}).some(([k, v]) => dims[k] !== undefined && String(dims[k]) !== String(v))) continue;
    const code = nafCode(dims[cfg.dimension_naf], naf);
    const m = o.measures?.[cfg.mesure];
    const rawValue = m && typeof m === 'object' ? m.value : m;
    const value = rawValue === null || rawValue === undefined || rawValue === '' ? NaN : Number(rawValue);
    const period = String(dims[cfg.dimension_periode] ?? '');
    if (!code || !Number.isFinite(value) || !period) { ignored++; continue; }
    const prev = best.get(code);
    if (!prev || periodKey(period) > periodKey(prev.periode)) best.set(code, { periode: period, valeur: value });
  }
  const entries = [...best.entries()].map(([code, x]) => ({
    indicateur: cfg.indicateur,
    naf: code,
    valeur: Math.round(x.valeur * (cfg.facteur ?? 1) * 100) / 100,
    periode: x.periode,
    perimetre: cfg.perimetre,
    source: cfg.source,
    url: cfg.url,
    statut: 'verifie',
    origine: 'api:melodi:' + cfg.dataset,
  }));
  return { entries, ignored };
}

/** Recherche data.gouv.fr → liens de documentation. */
export function parseDatagouv(json) {
  if (!Array.isArray(json?.data)) throw new Error('data.gouv.fr : format non reconnu');
  return json.data.slice(0, 5).map((d) => ({
    titre: String(d.title || 'Jeu de données'),
    url: String(d.page || ('https://www.data.gouv.fr/fr/datasets/' + encodeURIComponent(d.slug || d.id || '') + '/')),
    producteur: String(d.organization?.name || 'data.gouv.fr'),
    modifie: String(d.last_update || d.last_modified || ''),
  })).filter((l) => l.url.startsWith('https://'));
}

/**
 * Assemble references.json.
 * - manuel : entrées saisies à la main ;
 * - auto   : { [origine]: entries[] } des sources qui ont répondu ;
 * - previous : ancien references.json, dont on conserve les entrées des sources en échec.
 */
export function build({ manuel, auto, liens, previous, failed, now, naf, priorites }) {
  const kept = (previous?.indicateurs || []).filter((e) => e.origine && failed.some((f) => e.origine.startsWith(f)));
  const fresh = Object.values(auto).flat();
  const manual = manuel.map((e) => ({ ...e, origine: 'manuel' }));
  const all = [...fresh, ...kept, ...manual];
  // Une valeur automatique vérifiée prime sur une saisie manuelle pour le même indicateur, secteur et période.
  const seen = new Set();
  const indicateurs = [];
  for (const e of all) {
    const k = e.indicateur + '|' + e.naf + '|' + e.periode;
    if (seen.has(k)) continue;
    seen.add(k);
    indicateurs.push(e);
  }
  indicateurs.sort((a, b) => a.indicateur.localeCompare(b.indicateur) || a.naf.localeCompare(b.naf) || periodKey(b.periode).localeCompare(periodKey(a.periode)));
  return {
    schema: SCHEMA_VERSION,
    genere_le: now,
    avertissement: 'Repères statistiques publics, datés et sourcés. Ils contextualisent la situation du client ; ce ne sont ni des objectifs ni des normes.',
    definitions: priorites.indicateurs,
    priorites: priorites.priorites,
    naf: { divisions: naf.divisions, sections: naf.sections, agregats: naf.agregats, categories_simulateur: naf.categories_simulateur },
    indicateurs,
    liens: liens || previous?.liens || {},
  };
}

/** Contrôles bloquants : un fichier invalide n'est jamais publié. */
export function validate(refs) {
  const errors = [];
  if (refs?.schema !== SCHEMA_VERSION) errors.push('schema différent de ' + SCHEMA_VERSION);
  if (!Array.isArray(refs?.indicateurs)) return [...errors, 'indicateurs absent'];
  const defs = refs.definitions || {};
  const codes = new Set(['*', ...Object.keys(refs.naf?.divisions || {}), ...Object.keys(refs.naf?.sections || {}), ...Object.keys(refs.naf?.agregats || {})]);
  refs.indicateurs.forEach((e, i) => {
    const where = `indicateurs[${i}] (${e.indicateur}/${e.naf})`;
    if (!defs[e.indicateur]) errors.push(where + ' : indicateur inconnu');
    if (!codes.has(e.naf)) errors.push(where + ' : code NAF inconnu');
    if (!Number.isFinite(e.valeur)) errors.push(where + ' : valeur non numérique');
    for (const f of ['periode', 'perimetre', 'source', 'url', 'statut', 'origine']) if (!e[f]) errors.push(where + ' : champ ' + f + ' manquant');
    if (e.url && !/^https:\/\//.test(e.url)) errors.push(where + ' : URL non HTTPS');
    if (e.statut && !['verifie', 'a_verifier'].includes(e.statut)) errors.push(where + ' : statut invalide');
  });
  for (const [id, p] of Object.entries(refs.priorites || {})) {
    for (const ind of p.indicateurs || []) if (!defs[ind]) errors.push(`priorité ${id} : indicateur ${ind} non défini`);
    if (!(p.indicateurs || []).length && !p.sans_donnee_publique) errors.push(`priorité ${id} : ni indicateur ni explication`);
  }
  return errors;
}

/**
 * Repère le plus précis pour un secteur : division → section → agrégat → national.
 * Utilisé par le simulateur (même logique) ; renvoie null si rien n'est disponible.
 */
export function resolve(refs, indicateur, code) {
  const naf = refs.naf;
  const chain = [];
  if (naf.divisions[code]) chain.push(code, naf.divisions[code].section);
  else if (naf.sections[code]) chain.push(code);
  else if (naf.agregats[code]) chain.push(code);
  const section = chain.find((c) => naf.sections[c]);
  for (const [k, a] of Object.entries(naf.agregats)) if (section && a.sections.includes(section)) chain.push(k);
  chain.push('*');
  for (const c of chain) {
    const hits = refs.indicateurs.filter((e) => e.indicateur === indicateur && e.naf === c);
    if (hits.length) return { ...hits.sort((a, b) => periodKey(b.periode).localeCompare(periodKey(a.periode)))[0], niveau: c === code ? 'secteur' : c === '*' ? 'national' : 'regroupement' };
  }
  return null;
}
