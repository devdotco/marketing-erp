-- Google text-to-speech (Gemini API TTS) joins Cartesia as a voice provider
-- for the Podcast agent. Additive only: start.sh migrates while the previous
-- container is still serving, and an enum value it has never heard of is
-- harmless to it.
ALTER TYPE "IntegrationProvider" ADD VALUE IF NOT EXISTS 'GOOGLE_TTS';
