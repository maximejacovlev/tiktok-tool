# TikTok Carousel Tool

Petit outil web pour :
1. Extraire toutes les images d'un carrousel TikTok à partir de son lien.
2. Télécharger les PNG un par un (ou tout en ZIP).
3. Les retoucher (superposer des visuels depuis ta propre banque d'images).
4. Exporter le post final en ZIP, prêt à uploader manuellement sur Instagram / TikTok.

## Ce qui n'est PAS inclus (volontairement, voir discussion)

- **Pas de publication automatique via API.** Ce périmètre a été mis de côté pour cette première version.
- **Pas de vrai "brouillon" Instagram possible techniquement** : l'API Graph de Meta ne propose aucun endpoint de sauvegarde en brouillon, seulement publication immédiate ou rien. C'est une limite de la plateforme, pas de cet outil.
- **TikTok a un vrai mode brouillon via API**, mais il faut créer une app sur TikTok for Developers et la faire auditer par TikTok avant de pouvoir l'utiliser. Ça peut être branché plus tard une fois ton app approuvée.
- Pour l'instant, l'export produit un ZIP des images finales que tu uploades toi-même — c'est la solution de repli qu'on a choisie ensemble.

## Installation

```bash
npm install
npm start
```

Le serveur démarre sur `http://localhost:3000`.

### Navigateur pour le scraping (Playwright)

Le scraping du carrousel TikTok utilise Playwright avec Chromium headless. Au premier `npm install`, Playwright télécharge automatiquement Chromium. Si besoin de le forcer :

```bash
npx playwright install chromium
```

## Déploiement

Cet outil a été développé et testé dans un environnement sandbox sans accès réseau à tiktok.com (uniquement les registres npm/pip étaient autorisés) — **le scraping n'a donc pas pu être testé en conditions réelles ici**. Le code utilise une technique standard et documentée (lecture du JSON hydraté par TikTok dans la balise `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">` de la page), mais :

- **Teste-le avec un vrai lien de carrousel dès que tu le déploies** — c'est la première chose à vérifier.
- TikTok change parfois la structure de ses pages ; si l'extraction casse un jour, il faudra ajuster `src/scraper.js` (fonction `deepFindItemStruct`).
- Le scraping automatisé de TikTok peut être contraire à leurs conditions d'utilisation selon l'usage — à utiliser uniquement sur du contenu dont tu as les droits (ex: tes propres posts).

Pour héberger en ligne :

- **Vercel** : supporté via `api/index.js` + `vercel.json`. Le scraping utilise fetch HTTP (pas Playwright). Les données (carrousels, banque, titres) sont stockées dans `/tmp` — **elles sont effacées entre les redéploiements** et ne sont pas partagées entre instances.
- **Render / Railway / Fly.io / VPS** : mieux si tu veux un stockage persistant et Playwright en fallback. Lance `npm install` (inclut Playwright en dev) puis `npm start`.

## Structure du projet

```
src/
  server.js      -> API Express (scrape, proxy image, banque d'images, export)
  scraper.js      -> Logique Playwright d'extraction du carrousel
public/
  index.html       -> Interface (extraction, galerie, banque, éditeur, export)
  app.js           -> Logique frontend (éditeur canvas, appels API)
  style.css
uploads/
  bank/            -> Images uploadées dans la banque d'images
  exports/         -> Dossiers de posts exportés (source des ZIP téléchargés)
```

## Utilisation

1. Colle un lien de carrousel TikTok (URL contenant `/photo/`) et clique "Extraire les slides".
2. Chaque slide apparaît dans une grille — télécharge-la en PNG individuellement, ou clique "Éditer" pour ouvrir l'éditeur.
3. Dans l'éditeur : clique une image de ta banque pour l'ajouter en calque sur la slide, déplace-la, redimensionne-la (poignée en bas à droite de l'image sélectionnée), puis "Enregistrer cette slide".
4. Une fois toutes les slides prêtes, donne un nom au post et clique "Exporter toutes les slides retouchées" → un ZIP est téléchargé.
5. Upload ce ZIP manuellement sur Instagram et/ou TikTok.

## Prochaines étapes possibles

- Créer une app TikTok for Developers, la faire auditer, puis brancher l'API Content Posting pour un vrai envoi en brouillon TikTok.
- Pour Instagram, la seule option API est la publication immédiate (pas de brouillon) — à activer seulement si tu es à l'aise avec ce compromis.
- Ajouter la rotation/le recadrage libre des slides dans l'éditeur (actuellement : uniquement superposition d'images de la banque).
