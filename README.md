# Language Friend

Language Friend is a React/Vite interface with a FastAPI voice and language-service backend. The existing Vercel configuration is unchanged; Docker Compose is a local, self-contained way to run the same app.

## Run locally with Docker

From the repository root, run:

```powershell
docker compose up --build
```

Open [http://localhost:8080](http://localhost:8080) (the main screen redirects to Human Chat). The AI Bot is at [http://localhost:8080/ai](http://localhost:8080/ai). The frontend proxies `/api/*` to the internal `backend` Compose service, so the backend is not published to the host and browser code never receives provider credentials.

To check the backend through that proxy:

```powershell
Invoke-WebRequest http://localhost:8080/api/health | Select-Object -Expand Content
```

Stop the stack with:

```powershell
docker compose down
```

## Running without keys

No `.env` file or provider key is required for the Compose stack to start. Human Chat, AI Bot, and Settings can all be opened. Live transcription, translation, AI replies, pronunciation conversion, and speech playback need their respective providers; an attempted unavailable feature shows its backend configuration message rather than a sample or simulated result. Only actual provider responses are rendered as translations or AI replies.

## Optional provider setup

Create an untracked root `.env` file before starting Compose, or set the same variables in your shell. These values are passed only to the backend container:

```dotenv
# At least one language provider enables live text translation, pronunciation, and AI Bot replies.
GEMINI_API_KEY=...
# or
SARVAM_API_KEY=...

# Gnani is required for microphone transcription and generated speech.
GNANI_API_KEY=...
GNANI_STT_URL=https://...
GNANI_TTS_URL=https://...
```

`GEMINI_MODEL`, `SARVAM_CHAT_MODEL`, and the Sarvam endpoint override variables in `docker-compose.yml` are optional. When both Gemini and Sarvam are configured, Gemini is tried first and Sarvam remains a fallback; Sarvam can also operate by itself.

`.dockerignore` files exclude `.env` files, virtual environments, dependency directories, generated output, recordings, logs, and other local artifacts from the respective image build contexts.
