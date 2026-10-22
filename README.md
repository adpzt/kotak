# Kotak — la boîte à outils du DA (extension Chrome / Brave / Edge)

Quatre modules dans un panneau latéral. Tout tourne sur ton ordinateur : sans IA, sans service payant, sans limite.

| Module | Ce qu'il fait |
|---|---|
| **Convertir** | Tous formats → JPG, WebP, AVIF, PNG, GIF, JPEG XL, TIFF, PDF (+ PDF unique), BMP, ICO, SVG vectorisé, QOI. Compression en % ou **poids cible**, redimensionnement, lots, ZIP. Entrée : HEIC, PSD, TIFF, PDF, RAW, JPEG XL, SVG… |
| **Couleurs** | Pipette **sur tout l'écran** (même hors du navigateur), HEX copié automatiquement sans #, RGB, CMJN, HSL, historique, nuancier **.ase** |
| **Scrap** | Toutes les images d'une page (meilleure résolution, SVG intégrés, fonds CSS…), **capture de page entière**, **image vidéo en résolution native** |
| **Lien** | Colle un lien (YouTube, TikTok, Instagram, X, Vimeo…) → vidéo jusqu'en 4K/8K (H.264, HEVC, ProRes, original), audio MP3 / WAV 24 bits / AIFF / FLAC…, miniature. **Passage** de tel moment à tel moment (bouton ⏱ = position de la vidéo en cours, `?t=` / `start=` / `end=` des liens lus automatiquement) |

## Installer

Rien à installer avant (ni git, ni outils de développement, ni Python) : une seule commande suffit.

### Mac
Dans le Terminal :
```bash
curl -fsSL https://raw.githubusercontent.com/adpzt/kotak/main/scripts/install-mac.sh | bash
```

### Windows
Dans PowerShell :
```powershell
irm https://raw.githubusercontent.com/adpzt/kotak/main/scripts/install-windows.ps1 | iex
```

Le script installe :
- l'extension dans **`~/Extension Kotak`** (Mac) ou **`%USERPROFILE%\Extension Kotak`** (Windows) ;
- le **moteur Lien** (yt-dlp + ffmpeg, open source, avec un Python portable réservé à Kotak) : dans `~/Library/Application Support/Kotak` (Mac) ou `%LOCALAPPDATA%\Kotak` (Windows) ;
- une tâche de fond qui récupère les nouvelles versions de Kotak toutes les 15 min, et de yt-dlp chaque jour.

Puis, **une seule fois**, dans `chrome://extensions` (ou `brave://extensions`) : active le **Mode développeur**,
clique **Charger l'extension non empaquetée** et choisis le dossier `Extension Kotak`.
**Laisse le Mode développeur activé** : c'est ce qui permet à Kotak de se recharger tout seul à chaque mise à jour.

Ne mets pas l'extension sur un disque externe : macOS y interdit l'écriture aux tâches de fond, les mises à jour échoueraient.
Pour l'avoir sous la main, crée un raccourci : `ln -s ~/"Extension Kotak" "/chemin/Extension Kotak"`.

Désinstaller : `bash ~/Library/Application\ Support/Kotak/uninstall.sh` (Mac) ou
`powershell -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\Kotak\uninstall.ps1"` (Windows).

## Publier une nouvelle version

Pousser sur `main` suffit : GitHub Actions construit l'extension et la publie sur la branche `release`
(version `0.3.<numéro de build>`, affichée à côté du logo). Tous les postes se mettent à jour seuls.

Développement : `npm install`, `npm run build`, puis charger `dist/` ; `npm run dev` reconstruit à chaque sauvegarde.

## Structure

```
public/manifest.json          manifeste MV3 (clé fixe => même identifiant partout)
public/host/kotak_host.py     moteur du module Lien (Native Messaging, Mac + Windows), livré avec l'extension
src/background.ts             service worker : panneau, clic droit, mise à jour auto, presse-papier
src/core/                     moteur d'images (décodage, encodage, déclinaisons) indépendant de l'interface
src/sidepanel/                interface : nav.ts (onglets), modules/*.ts, components/ (convertisseur)
src/lib/                      fichiers, couleurs (.ase), presse-papier, client du moteur Lien
scripts/install-mac.sh        installation Mac
scripts/install-windows.ps1   installation Windows
```

## Limites connues

- **RAW** : aperçu JPEG intégré par l'appareil (pleine résolution chez Canon et Nikon, parfois réduite ailleurs).
- **PSD** : image aplatie, le fichier doit être enregistré avec « Maximiser la compatibilité ».
- **CMJN** : conversion standard sans profil ICC, proche mais pas identique à Photoshop.
- **Lien** : pour diffuser un contenu téléchargé, il faut en avoir les droits. Certains contenus demandent
  ta session (choix « Session » dans le module). Sur Windows, les conversions H.264 / HEVC / ProRes sont
  logicielles (plus lentes que l'encodeur matériel du Mac).
- Les pages internes du navigateur (chrome://, Web Store) ne peuvent pas être analysées ni capturées.
