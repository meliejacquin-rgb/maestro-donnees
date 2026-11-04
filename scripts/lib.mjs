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

/**
 * Code d'activité des comptes nationaux → liste de codes NAF couverts, avec un rang de précision.
 * « C16 » → [16] ; « C10T12 » → [10,11,12] ; « C29_30 » → [29,30] ; « F » → [F] ; « BTE » → [B-E] ; « _T » → [*].
 */
export function branchCodes(raw, naf) {
  const s = String(raw || '').toUpperCase().trim();
  if (s === '_T' || s === 'TOTAL') return { codes: ['*'], rang: 3 };
  let m;
  if ((m = s.match(/^([A-U])$/)) && naf.sections[m[1]]) return { codes: [m[1]], rang: 1 };
  if ((m = s.match(/^[A-U](\d{2})$/)) && naf.divisions[m[1]]) return { codes: [m[1]], rang: 0 };
  if ((m = s.match(/^[A-U](\d{2})(?:T|_)(\d{2})$/))) {
    const codes = Object.keys(naf.divisions).filter((d) => d >= m[1] && d <= m[2]);
    return codes.length ? { codes, rang: 0.5 } : null;
  }
  if ((m = s.match(/^([A-U])T([A-U])$/))) {
    const want = Object.keys(naf.sections).filter((x) => x >= m[1] && x <= m[2]);
    for (const [k, a] of Object.entries(naf.agregats)) if (a.sections.join() === want.join()) return { codes: [k], rang: 2 };
  }
  return null;
}

const matches = (dims, filters) => Object.entries(filters || {}).every(([k, v]) => String(dims[k]) === String(v));

/**
 * Ratio calculé à partir des comptes nationaux par branche : numérateur / dénominateur × facteur,
 * pour la dernière année où les deux existent. Les doublons (plusieurs observations pour la même
 * branche et année) rendent la valeur ambiguë : elle est écartée et signalée.
 * Option « croissance » : variation annuelle du numérateur seul.
 */
export function computeBranchRatio(obsNum, obsDen, cfg, naf) {
  const diag = {};
  const index = (obs, side) => {
    const map = new Map(), dup = new Set(), first = new Map();
    for (const o of obs) {
      const d = o.dimensions || {};
      if (cfg.annee_min && Number(String(d.TIME_PERIOD).slice(0, 4)) < cfg.annee_min) continue;
      if (!matches(d, { ...(cfg.filtres || {}), ...(side || {}) })) continue;
      const m = o.measures?.OBS_VALUE_NIVEAU;
      const raw = m && typeof m === 'object' ? m.value : m;
      if (raw === null || raw === undefined || raw === '' || !Number.isFinite(Number(raw))) continue;
      const k = d.ACTIVITY + '|' + d.TIME_PERIOD;
      const v = Number(raw) * 10 ** Number(o.attributes?.UNIT_MULT || 0); // valeurs ramenées en unités
      const score = Object.entries(cfg.preference || {}).filter(([x, want]) => String(d[x]) === String(want)).length;
      if (map.has(k)) {
        const prev = map.get(k);
        if (Math.abs(prev.v - v) <= 1e-9 * Math.max(1, Math.abs(v))) continue; // même valeur publiée deux fois
        if (score !== prev.score) { if (score > prev.score) { map.set(k, { v, score }); dup.delete(k); } continue; } // variante préférée
        dup.add(k);
        if (!diag.exemple) { const a = first.get(k); diag.exemple = Object.keys({ ...a, ...d }).filter((x) => a[x] !== d[x]).map((x) => `${x}: ${a[x]} / ${d[x]}`); }
        continue;
      }
      first.set(k, d);
      map.set(k, { v, score });
    }
    for (const k of dup) map.delete(k);
    return { map: new Map([...map].map(([k, x]) => [k, x.v])), dup: dup.size };
  };
  const num = index(obsNum, cfg.numerateur);
  const den = cfg.croissance ? null : index(obsDen, cfg.denominateur);
  const byActivity = new Map();
  for (const [k, v] of num.map) {
    const [act, period] = k.split('|');
    let value;
    if (cfg.croissance) {
      const prev = num.map.get(act + '|' + String(Number(period) - 1));
      if (!prev) continue;
      value = (v / prev - 1) * 100;
    } else {
      const d = den.map.get(k);
      if (!d) continue;
      value = (v / d) * (cfg.facteur ?? 1);
    }
    if (!Number.isFinite(value) || value < cfg.bornes[0] || value > cfg.bornes[1]) continue;
    const prev = byActivity.get(act);
    if (!prev || period > prev.periode) byActivity.set(act, { periode: period, valeur: value });
  }
  const entries = [], nonReconnus = new Set();
  const ranked = [];
  for (const [act, x] of byActivity) {
    const b = branchCodes(act, naf);
    if (!b) { nonReconnus.add(act); continue; }
    for (const code of b.codes) ranked.push({ code, rang: b.rang, act, ...x });
  }
  ranked.sort((a, b) => a.rang - b.rang);
  const seen = new Set();
  for (const r of ranked) {
    if (seen.has(r.code)) continue;
    seen.add(r.code);
    entries.push({
      indicateur: cfg.indicateur,
      naf: r.code,
      valeur: Math.round(r.valeur * 10) / 10,
      periode: r.periode,
      perimetre: cfg.perimetre + (r.rang === 0.5 ? ` (branche regroupée ${r.act})` : ''),
      source: cfg.source,
      url: cfg.url,
      methode: cfg.methode,
      statut: 'verifie',
      origine: 'api:melodi:' + cfg.dataset + ':' + cfg.indicateur,
    });
  }
  return { entries, doublons: num.dup + (den?.dup || 0), doublon_exemple: diag.exemple || null, non_reconnus: [...nonReconnus] };
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
export function build({ manuel, auto, liens, previous, failed, now, naf, priorites, indices }) {
  const kept = (previous?.indicateurs || []).filter((e) => e.origine && failed.some((f) => e.origine.startsWith(f)));
  const fresh = Object.values(auto).flat();
  const manual = manuel.map((e) => ({ ...e, origine: 'manuel' }));
  const all = [...fresh, ...kept, ...manual];
  // Une valeur automatique vérifiée prime sur une saisie manuelle pour le même indicateur, secteur et période.
  const seen = new Set();
  const indicateurs = [];
  for (const e of all) {
    // Un même secteur peut avoir un repère par taille d'entreprise (« population ») : ils coexistent.
    const k = e.indicateur + '|' + e.naf + '|' + e.periode + '|' + (e.population || '');
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
    // Indices de prix (révision des honoraires) : conservés tels quels si la collecte du mois échoue.
    indices: { ...(previous?.indices || {}), ...(indices || {}) },
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
    if (e.population && !['micro', 'pme_ge'].includes(e.population)) errors.push(where + ' : population inconnue (micro ou pme_ge)');
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

/** Séries SDMX (format « StructureSpecific ») de la base BDM de l'INSEE : attributs + observations triées. */
export function parseBdmSeries(xml) {
  const attrs = (txt) => Object.fromEntries([...String(txt).matchAll(/([A-Za-z_][\w-]*)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
  return [...String(xml).matchAll(/<Series\b([^>]*)>([\s\S]*?)<\/Series>/g)].map(([, a, body]) => ({
    ...attrs(a),
    obs: [...body.matchAll(/<Obs\b([^>]*?)\/?>/g)].map((m) => attrs(m[1]))
      .filter((o) => o.TIME_PERIOD && o.OBS_VALUE !== undefined && o.OBS_VALUE !== '' && o.OBS_VALUE !== 'NaN')
      .map((o) => ({ periode: o.TIME_PERIOD, valeur: Number(o.OBS_VALUE) }))
      .filter((o) => Number.isFinite(o.valeur))
      .sort((x, y) => x.periode.localeCompare(y.periode)),
  }));
}

/** Défaillances d'entreprises : cumul 12 mois par grand secteur → repères (un par code NAF de la correspondance). */
export function buildDefaillances(series, cfg) {
  const out = [];
  const mois = (p) => { const [y, m] = p.split('-'); return `${m}/${y}`; };
  for (const s of series) {
    if (Object.entries(cfg.filtre).some(([k, v]) => s[k] !== v)) continue;
    if (cfg.titre_contient && !String(s.TITLE_FR || '').includes(cfg.titre_contient)) continue;
    const codes = cfg.correspondance[s.ACTIVITE_CREAT_ENT];
    const last = s.obs.at(-1);
    if (!codes || !last) continue;
    const [y, m] = last.periode.split('-').map(Number);
    const ilYaUnAn = `${y - 1}-${String(m).padStart(2, '0')}`;
    const prev = s.obs.find((o) => o.periode === ilYaUnAn);
    const evolution = prev && prev.valeur ? Math.round(((last.valeur - prev.valeur) / prev.valeur) * 1000) / 10 : null;
    const secteur = String(s.TITLE_FR || '').split(' - ').at(-1);
    for (const naf of codes) {
      out.push({
        indicateur: cfg.indicateur, naf, valeur: last.valeur,
        periode: `12 mois glissants à fin ${mois(last.periode)}`,
        perimetre: `France, ${secteur} : défaillances par date de jugement, cumul brut sur 12 mois`,
        methode: evolution === null ? undefined : `${evolution > 0 ? '+' : ''}${String(evolution).replace('.', ',')} % sur un an`,
        source: `${cfg.source} (série ${s.IDBANK})`,
        url: `https://www.insee.fr/fr/statistiques/serie/${s.IDBANK}`,
        statut: 'verifie', origine: cfg.origine,
      });
    }
  }
  return out;
}

/**
 * Salaire brut moyen par salarié (URSSAF, secteur privé, France entière, données annuelles par secteur NA88) :
 * masse salariale / effectif salarié moyen de la dernière année publiée, en k€ par an.
 * Les secteurs regroupés (« 05-06 ») ou scindés (« 78a », « 78b ») sont additionnés par division NAF ;
 * les sections et le total national sont recalculés à partir des mêmes données.
 */
export function buildSalaires(records, cfg, naf) {
  const annee = (r) => String(r.annee || '').slice(0, 4);
  const derniere = records.map(annee).filter((y) => /^\d{4}$/.test(y)).sort().at(-1);
  if (!derniere) return [];
  const div = new Map(), add = (m, k, ms, ef) => { const v = m.get(k) || { ms: 0, ef: 0 }; v.ms += ms; v.ef += ef; m.set(k, v); };
  for (const r of records) {
    if (annee(r) !== derniere) continue;
    const ms = Number(r.masse_salariale), ef = Number(r.effectifs_salaries_moyens);
    if (!(ms > 0 && ef > 0)) continue;
    const m = String(r.secteur_na88i || '').match(/^(\d{2})[ab]?(?:-(\d{2}))?\s/);
    if (!m) continue;
    const codes = m[2] ? Object.keys(naf.divisions).filter((d) => d >= m[1] && d <= m[2]) : [m[1]];
    if (!codes.length || !codes.every((c) => naf.divisions[c])) continue;
    // Secteur regroupé : la même valeur moyenne s'applique à chaque division du regroupement.
    for (const c of codes) add(div, c, ms / codes.length, ef / codes.length);
  }
  const sections = new Map(), total = { ms: 0, ef: 0 };
  for (const [c, v] of div) { add(sections, naf.divisions[c].section, v.ms, v.ef); total.ms += v.ms; total.ef += v.ef; }
  const k = (v) => Math.round((v.ms / v.ef) / 100) / 10;
  const entry = (code, v, portee) => ({
    indicateur: cfg.indicateur, naf: code, valeur: k(v), periode: derniere,
    perimetre: `${cfg.perimetre}${portee}`, methode: cfg.methode, source: cfg.source, url: cfg.url, statut: 'verifie', origine: cfg.origine,
  });
  const out = [...div].map(([c, v]) => entry(c, v, ''));
  for (const [s, v] of sections) out.push(entry(s, v, ' (ensemble de la section)'));
  if (total.ef) out.push(entry('*', total, ' (ensemble des secteurs couverts)'));
  return out;
}

/**
 * Indice de prix pour la révision des honoraires (série BDM de l'INSEE) : 12 dernières valeurs trimestrielles.
 * « 2026-Q2 » est affiché « T2 2026 ».
 */
export function buildIndice(series, cfg) {
  const s = series.find((x) => x.IDBANK === cfg.idbank);
  if (!s || !s.obs.length) return null;
  const libelle = (p) => { const m = String(p).match(/^(\d{4})-Q(\d)$/); return m ? `T${m[2]} ${m[1]}` : String(p); };
  const obs = s.obs.slice(-12).map((o) => ({ periode: o.periode, libelle: libelle(o.periode), valeur: o.valeur }));
  return { libelle: cfg.libelle, idbank: cfg.idbank, titre_insee: s.TITLE_FR || '', source: cfg.source, url: `https://www.insee.fr/fr/statistiques/serie/${cfg.idbank}`, base: cfg.base, derniere: obs.at(-1), obs };
}
