// Builds provider-specific TTS options (and a cache "voice signature") from
// saved settings + keys. Extracted from listen.js so the background service
// worker can reuse it for headless keyboard-shortcut playback (read-selection
// / read-page) without opening the side panel.
import { Storage } from './storage.js';

export async function buildOptions(provider) {
  const [settings, keys] = await Promise.all([Storage.getSettings(), Storage.getKeys()]);
  switch (provider) {
    case 'webspeech':
      return { options: { voiceURI: settings.ttsVoiceURI }, voiceSig: `ws:${settings.ttsVoiceURI}` };
    case 'gtranslate':
      return { options: { lang: settings.gtranslateLang }, voiceSig: `gt:${settings.gtranslateLang}` };
    case 'groqtts':
      if (!keys.groqKey) throw new Error('Add a Groq API key in Settings first (free at console.groq.com).');
      return {
        options: { apiKey: keys.groqKey, voice: settings.groqTtsVoice, model: 'canopylabs/orpheus-v1-english' },
        voiceSig: `gq:orpheus:${settings.groqTtsVoice}`
      };
    case 'deepgramtts':
      if (!keys.deepgramKey) throw new Error('Add a Deepgram API key in Settings first ($200 free credit at deepgram.com).');
      return {
        options: { apiKey: keys.deepgramKey, model: settings.deepgramTtsModel },
        voiceSig: `dg:${settings.deepgramTtsModel}`
      };
    case 'openai':
      if (!keys.openaiKey) throw new Error('Add an OpenAI API key in Settings first.');
      return {
        options: { apiKey: keys.openaiKey, voice: settings.openaiTtsVoice, model: settings.openaiTtsModel },
        voiceSig: `oa:${settings.openaiTtsModel}:${settings.openaiTtsVoice}`
      };
    case 'elevenlabs':
      if (!keys.elevenlabsKey) throw new Error('Add an ElevenLabs API key in Settings first.');
      return {
        options: {
          apiKey: keys.elevenlabsKey,
          voiceId: settings.elevenVoiceId,
          modelId: settings.elevenModelId,
          stability: settings.elevenStability,
          similarity: settings.elevenSimilarity
        },
        voiceSig: `el:${settings.elevenModelId}:${settings.elevenVoiceId}`
      };
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

// Two distinct voices for podcast mode. Host A keeps the user's configured
// voice; Host B gets a stable, clearly different default.
export function buildHostVoices(provider, hostA) {
  const a = { ...hostA.options };
  const b = { ...hostA.options };
  let sigB = hostA.voiceSig + ':B';
  if (provider === 'openai') {
    b.voice = a.voice === 'nova' ? 'onyx' : 'nova';
    sigB = `oa:${b.model}:${b.voice}`;
  } else if (provider === 'groqtts') {
    b.voice = a.voice === 'troy' ? 'hannah' : 'troy';
    sigB = `gq:orpheus:${b.voice}`;
  } else if (provider === 'deepgramtts') {
    b.model = a.model === 'aura-2-apollo-en' ? 'aura-2-thalia-en' : 'aura-2-apollo-en';
    sigB = `dg:${b.model}`;
  } else if (provider === 'elevenlabs') {
    const RACHEL = '21m00Tcm4TlvDq8ikWAM';
    const ADAM = 'pNInz6obpgDQGcFmaJgB';
    b.voiceId = a.voiceId === RACHEL ? ADAM : RACHEL;
    sigB = `el:${b.modelId}:${b.voiceId}`;
  }
  // webspeech: the player picks an alternate voice for Host B itself.
  return {
    hostVoices: { A: a, B: b },
    voiceSigs: { A: hostA.voiceSig, B: sigB }
  };
}
