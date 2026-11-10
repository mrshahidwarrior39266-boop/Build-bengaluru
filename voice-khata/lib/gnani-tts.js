import WebSocket from 'ws';

export class GnaniTTS {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.wsUrl = 'wss://api.vachana.ai/api/v1/tts';
    this.restUrl = 'https://api.vachana.ai/api/v1/tts/inference';
  }

  // WebSocket-based streaming TTS
  async synthesize(text, options = {}) {
    if (!this.apiKey) {
      console.log('[Gnani TTS] GNANI_API_KEY not configured, skipping voice synthesis');
      return [];
    }
    const {
      voice = 'Shivani',
      model = 'timbre-v3.0',
      language = 'hi-IN',
      speed = 1.0
    } = options;

    return new Promise((resolve, reject) => {
      const chunks = [];
      
      const ws = new WebSocket(this.wsUrl, {
        headers: {
          'x-api-key-id': this.apiKey
        },
        perMessageDeflate: false
      });

      ws.on('open', () => {
        console.log('[Gnani TTS] Connected to Timbre v3.0');
        // Send synthesis request
        ws.send(JSON.stringify({
          text,
          voice,
          model,
          language,
          speed,
          audio_config: {
            sample_rate: 24000,
            num_channels: 1,
            sample_width: 2,
            encoding: 'linear_pcm',
            container: 'wav'
          }
        }));
      });

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.audio || msg.audio_data) {
            chunks.push({
              audio: msg.audio || msg.audio_data,
              is_final: msg.is_final || false
            });
          }
          if (msg.is_final) {
            ws.close();
            resolve(chunks);
          }
        } catch (err) {
          console.error('[Gnani TTS] Parse error:', err);
        }
      });

      ws.on('error', (err) => {
        console.error('[Gnani TTS] Error:', err.message);
        reject(err);
      });

      ws.on('close', () => {
        if (chunks.length > 0) {
          resolve(chunks);
        }
      });

      // Timeout after 10s
      setTimeout(() => {
        if (ws.readyState !== WebSocket.CLOSED) {
          ws.close();
          if (chunks.length > 0) resolve(chunks);
          else reject(new Error('TTS timeout'));
        }
      }, 10000);
    });
  }

  // REST-based TTS (fallback, simpler)
  async synthesizeREST(text, options = {}) {
    const {
      voice = 'Shivani',
      model = 'timbre-v3.0',
      language = 'hi-IN',
      speed = 1.0
    } = options;

    const response = await fetch(this.restUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key-id': this.apiKey
      },
      body: JSON.stringify({ text, voice, model, language, speed })
    });

    if (!response.ok) {
      throw new Error(`TTS REST error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    return data;
  }
}
