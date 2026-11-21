# Language Friend

## Run the frontend

```powershell
npm.cmd install
npm.cmd run dev
```

The Vite development server proxies `/api` calls to `http://127.0.0.1:8000`.

## Run the voice backend

Install Python 3.10+ first, then create `backend/.env` from `backend/.env.example` and provide:

- `GNANI_API_KEY`, `GNANI_STT_URL`, and `GNANI_TTS_URL` from the Gnani account/API configuration
- `GEMINI_API_KEY` from Google AI Studio / Gemini
- optionally `GEMINI_MODEL` (defaults to `gemini-2.5-flash`)
- optionally `FRONTEND_ORIGIN` (defaults to `http://localhost:5173`)

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

The app intentionally reports missing or rejected credentials and does not turn a failed live request into a sample result.

This template provides a minimal setup to get React working in Vite with HMR and some Oxlint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the Oxlint configuration

If you are developing a production application, we recommend enabling type-aware lint rules by installing `oxlint-tsgolint` and editing `.oxlintrc.json`:

```json
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "plugins": ["react", "typescript", "oxc"],
  "options": {
    "typeAware": true
  },
  "rules": {
    "react/rules-of-hooks": "error",
    "react/only-export-components": ["warn", { "allowConstantExport": true }]
  }
}
```

See the [Oxlint rules documentation](https://oxc.rs/docs/guide/usage/linter/rules) for the full list of rules and categories.
