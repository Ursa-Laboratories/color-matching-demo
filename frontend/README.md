# Ursa Learning frontend

React operator interface for generic active learning, color matching and overnight runs.

From this directory:

```sh
npm ci
npm run dev
```

The dev server proxies `/api` to the Ursa Learning backend at `http://127.0.0.1:8750`. Run that backend separately using the root README. It connects to CubOS through HTTP. The browser obtains the CubOS operator URL from the backend; `VITE_CUBOS_OPERATOR_URL` can override the link when the operator is served through a different tunnel.

```sh
npm run lint
npm test
npm run build
npm run test:e2e
```

The Playwright test mocks every API request and never contacts physical hardware. The production build is served by the Ursa Learning backend.
