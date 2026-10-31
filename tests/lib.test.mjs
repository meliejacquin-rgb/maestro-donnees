import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { branchCodes, computeBranchRatio, textFr, parseMelodiCatalog, discover, nafCode, normalizeMelodiData, parseDatagouv, build, validate, resolve, periodKey } from '../scripts/lib.mjs';

const naf = JSON.parse(await readFile(new URL('../naf.json', import.meta.url), 'utf8'));
const priorites = JSON.parse(await readFile(new URL('../config/priorites.json', import.meta.url), 'utf8'));
const manuel = JSON.parse(await readFile(new URL('../data/manuel.json', import.meta.url), 'utf8')).indicateurs;
const fixture = async (n) => JSON.parse(await readFile(new URL('./fixtures/' + n, import.meta.url), 'utf8'));

test('textFr lit les différentes formes de libellés INSEE', () => {
  assert.equal(textFr([{ lang: 'en', content: 'Margin' }, { lang: 'fr', content: 'Marge' }]), 'Marge');
  assert.equal(textFr({ content: 'x' }), 'x');
  assert.equal(textFr(null), '');
});

test('catalogue Melodi et découverte par mots-clés (accents ignorés)', async () => {
  const cat = parseMelodiCatalog(await fixture('melodi-catalog.json'));
  assert.equal(cat.length, 3);
  const found = discover(cat, ['taux de marge', 'defaillance']);
  assert.deepEqual(found.map((d) => d.id).sort(), ['DS_DEFAILLANCES', 'DS_ESANE_RATIOS']);
});

test('nafCode reconnaît divisions, sections et total', () => {
  assert.equal(nafCode('43', naf), '43');
  assert.equal(nafCode('NAF2_43', naf), '43');
  assert.equal(nafCode('F', naf), 'F');
  assert.equal(nafCode('_T', naf), '*');
  assert.equal(nafCode('34', naf), null); // division inexistante
});

test('données Melodi : dernière période par secteur, filtres appliqués', async () => {
  const cfg = { dataset: 'DS_ESANE_RATIOS', indicateur: 'taux_marge_ebe_va', filtres: { GEO: 'FRANCE-F' }, dimension_naf: 'ACTIVITY', dimension_periode: 'TIME_PERIOD', mesure: 'OBS_VALUE_NIVEAU', perimetre: 'p', source: 's', url: 'https://insee.fr' };
  const { entries, ignored } = normalizeMelodiData(await fixture('melodi-data.json'), cfg, naf);
  const f43 = entries.find((e) => e.naf === '43');
  assert.equal(f43.valeur, 21.5);
  assert.equal(f43.periode, '2023');
  assert.equal(entries.find((e) => e.naf === 'F').valeur, 18);
  assert.equal(ignored, 1);
  assert.ok(!entries.some((e) => e.valeur === 99)); // observation hors filtre GEO
});

test('data.gouv.fr → liens HTTPS', async () => {
  const l = parseDatagouv(await fixture('datagouv.json'));
  assert.equal(l.length, 1);
  assert.match(l[0].url, /^https:/);
});

test('build : sources en échec conservent les valeurs précédentes, fichier valide', () => {
  const previous = { indicateurs: [{ indicateur: 'va_par_salarie', naf: '43', valeur: 50, periode: '2022', perimetre: 'p', source: 's', url: 'https://x', statut: 'verifie', origine: 'api:melodi:DS_X' }] };
  const refs = build({ manuel, auto: {}, liens: null, previous, failed: ['api:melodi:DS_X'], now: 'n', naf, priorites });
  assert.ok(refs.indicateurs.some((e) => e.origine === 'api:melodi:DS_X'));
  assert.deepEqual(validate(refs), []);
});

test('validate rejette une valeur sans source ou un NAF inconnu', () => {
  const refs = build({ manuel, auto: {}, previous: null, failed: [], now: 'n', naf, priorites });
  refs.indicateurs.push({ indicateur: 'taux_marge_ebe_va', naf: 'ZZ', valeur: 'x', periode: '2023', perimetre: 'p', source: '', url: 'http://x', statut: 'verifie', origine: 'manuel' });
  const errs = validate(refs);
  assert.ok(errs.some((e) => e.includes('NAF inconnu')));
  assert.ok(errs.some((e) => e.includes('champ source')));
  assert.ok(errs.some((e) => e.includes('non HTTPS')));
});

test('resolve : division → section → agrégat → national, période la plus récente', () => {
  const refs = build({ manuel, auto: {}, previous: null, failed: [], now: 'n', naf, priorites });
  assert.equal(resolve(refs, 'taux_marge_ebe_va', '43').naf, 'F');
  assert.equal(resolve(refs, 'taux_marge_ebe_va', '25').naf, 'B-E');
  assert.equal(resolve(refs, 'taux_marge_ebe_va', '62').niveau, 'national');
  assert.equal(resolve(refs, 'delai_clients_jours', '43').periode, '2025');
  assert.equal(resolve(refs, 'evolution_ca', '43'), null);
});

test('periodKey trie par année', () => {
  assert.ok(periodKey('fin 2025') > periodKey('2024'));
  assert.ok(periodKey('2025') > periodKey('2023-T4'));
});

test('naf.json : 88 divisions, chacune dans une section', () => {
  assert.equal(Object.keys(naf.divisions).length, 88);
  for (const [d, v] of Object.entries(naf.divisions)) assert.ok(naf.sections[v.section].divisions.includes(d));
});

test('branchCodes : codes des comptes nationaux → NAF', () => {
  assert.deepEqual(branchCodes('C16', naf).codes, ['16']);
  assert.deepEqual(branchCodes('C10T12', naf).codes, ['10', '11', '12']);
  assert.deepEqual(branchCodes('C29_30', naf).codes, ['29', '30']);
  assert.deepEqual(branchCodes('F', naf).codes, ['F']);
  assert.deepEqual(branchCodes('BTE', naf).codes, ['B-E']);
  assert.deepEqual(branchCodes('_T', naf).codes, ['*']);
  assert.equal(branchCodes('GTI', naf), null); // regroupement multi-sections non comparable
});

const ob = (act, sto, period, value, mult = '6', extra = {}) => ({ attributes: { UNIT_MULT: mult }, dimensions: { ACTIVITY: act, STO: sto, TIME_PERIOD: period, FREQ: 'A', REF_SECTOR: 'S1', TRANSFORMATION: 'N', PRICES: 'V', UNIT_MEASURE: 'XDC', ...extra }, measures: { OBS_VALUE_NIVEAU: { value } } });
const base = { dataset: 'DD', filtres: { FREQ: 'A', REF_SECTOR: 'S1' }, perimetre: 'p', source: 's', url: 'https://insee.fr', methode: 'm' };

test('ratio de branche : dernière année commune, précision division > regroupement, doublons écartés', () => {
  const num = [ob('F', 'B2A3G', '2023', 30), ob('F', 'B2A3G', '2024', 33), ob('C22', 'B2A3G', '2024', 5), ob('C22_23', 'B2A3G', '2024', 8),
    ob('J', 'B2A3G', '2024', 1), ob('J', 'B2A3G', '2024', 2), ob('F', 'B2A3G', '2024', 99, '6', { REF_SECTOR: 'S11' })];
  const den = [ob('F', 'B1G', '2023', 100), ob('F', 'B1G', '2024', 110), ob('C22', 'B1G', '2024', 20), ob('C22_23', 'B1G', '2024', 40), ob('J', 'B1G', '2024', 10)];
  const r = computeBranchRatio(num, den, { ...base, indicateur: 'taux_marge_ebe_va', numerateur: { STO: 'B2A3G' }, denominateur: { STO: 'B1G' }, facteur: 100, bornes: [-50, 100] }, naf);
  const by = Object.fromEntries(r.entries.map((e) => [e.naf, e]));
  assert.equal(by.F.valeur, 30);       // 33/110, année 2024, la ligne S11 est filtrée
  assert.equal(by.F.periode, '2024');
  assert.equal(by['22'].valeur, 25);   // division exacte prioritaire sur C22_23
  assert.equal(by['23'].valeur, 20);   // couverte seulement par C22_23
  assert.match(by['23'].perimetre, /regroupée C22_23/);
  assert.equal(by.J, undefined);       // doublon → écarté
  assert.equal(r.doublons, 1);
});

test('ratio de branche : unités (millions / milliers) et bornes de plausibilité', () => {
  const num = [ob('F', 'B1G', '2024', 120000, '6'), ob('J', 'B1G', '2024', 1, '6')];
  const den = [ob('F', 'EMP', '2024', 1500, '3', { PRICES: '_Z', UNIT_MEASURE: 'PS' }), ob('J', 'EMP', '2024', 1000, '3', { PRICES: '_Z', UNIT_MEASURE: 'PS' })];
  const r = computeBranchRatio(num, den, { ...base, indicateur: 'va_par_salarie', numerateur: { STO: 'B1G' }, denominateur: { STO: 'EMP' }, facteur: 0.001, bornes: [5, 5000] }, naf);
  assert.equal(r.entries.length, 1);
  assert.equal(r.entries[0].valeur, 80); // 120 Md€ / 1,5 M emplois = 80 k€ ; J (1 k€) hors bornes
});

test('croissance annuelle de la production', () => {
  const num = [ob('F', 'P1', '2023', 200), ob('F', 'P1', '2024', 210)];
  const r = computeBranchRatio(num, [], { ...base, indicateur: 'evolution_ca', croissance: true, numerateur: { STO: 'P1' }, bornes: [-60, 100] }, naf);
  assert.equal(r.entries[0].valeur, 5);
  assert.equal(r.entries[0].periode, '2024');
});
