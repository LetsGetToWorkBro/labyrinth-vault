# LABYRINTH marketing site

The cinematic, scroll-driven marketing site for Labyrinth Vault and Labyrinth Wallet.

## Development

```sh
cd site
npm install
npm run dev
```

## Production build

```sh
npm run build
```

The deployable output is written to `site/dist/`.

The site is a standalone Vite + React application. Its scroll-controlled hero uses separate desktop and mobile H.264 encodes, with its generated film and editorial images served from durable HTTPS media URLs.
