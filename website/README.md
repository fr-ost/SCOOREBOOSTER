# ScoreX website

Static site (no build step): `index.html`, `styles.css`, `privacy.html`, `img/`.

## Deploy to Vercel

1. vercel.com > Add New > Project > import this repository.
2. Leave Root Directory as the repository root: the root `vercel.json` serves the `website/` folder (no build).
   (Or set Root Directory to `website`; both work.)
3. Deploy. Add your domain under Settings > Domains.

Or from this folder: `npx vercel --prod`.

The privacy policy is then at `/privacy` (use that URL in the Chrome Web Store listing if you prefer it to the
license server's copy). When the store link exists, point the "Request an invite" buttons or add an install button
in `index.html`.
