# maestro-donnees

Repères économiques sectoriels publics (INSEE, Banque de France) pour MaestroSim.

Ce dépôt est **public** et ne contient **que des statistiques publiques**. Le simulateur
(dépôt privé `MaestroSim`) télécharge `references.json` ; aucune donnée client n'est envoyée.

## Fonctionnement

| Élément | Rôle |
|---|---|
| `.github/workflows/collecte.yml` | Tâche automatique : le 3 de chaque mois, à la demande (onglet Actions → « Run workflow »), et à chaque pull request |
| `scripts/collect.mjs` | Interroge INSEE Melodi, data.gouv.fr (et la Banque de France si configurée), puis écrit `references.json` et `rapport-collecte.json` |
| `scripts/lib.mjs` | Mise en forme et contrôles (testés par `tests/lib.test.mjs`) |
| `config/priorites.json` | Pour chaque priorité Maestro, les indicateurs comparables ; ou l'explication quand aucune donnée publique n'existe |
| `config/sources.json` | Jeux de données INSEE à extraire, recherches data.gouv.fr, séries Banque de France |
| `data/manuel.json` | Repères saisis à la main, toujours avec source et URL |
| `naf.json` | Nomenclature NAF rév. 2 : 88 divisions, 21 sections |
| `index.html` | Page de consultation lisible des repères publiés |

**Garde-fous**
- Un fichier qui échoue aux contrôles (valeur sans source, URL non HTTPS, secteur inconnu…) n'est **jamais publié** ; la version précédente reste en ligne.
- Si une source ne répond pas, ses valeurs précédentes sont conservées et l'incident figure dans `rapport-collecte.json`.
- Chaque repère porte un statut : `verifie` (lu automatiquement dans l'API officielle) ou `a_verifier` (saisi à la main, à contrôler sur la publication).
- Résolution d'un secteur : division NAF (ex. 43) → section (F) → regroupement (industrie B-E) → France entière. Le simulateur indique toujours le niveau utilisé.

## Activer la publication (GitHub Pages) — une seule fois
1. **Settings** → **Pages**.
2. **Source** : « Deploy from a branch » ; **Branch** : `main`, dossier `/ (root)` → **Save**.
3. Après une à deux minutes : `https://meliejacquin-rgb.github.io/maestro-donnees/` (page lisible) et `…/references.json` (fichier lu par le simulateur).

## Clé Banque de France (facultatif)
Créer un compte gratuit sur le portail Webstat de la Banque de France, puis dans ce dépôt :
**Settings** → **Secrets and variables** → **Actions** → **New repository secret** → nom `BDF_API_KEY`.
La clé n'apparaît jamais dans le code ni dans le simulateur.

## Commandes
```bash
node --test tests/lib.test.mjs
```
```bash
node scripts/collect.mjs --offline
```
