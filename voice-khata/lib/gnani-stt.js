import WebSocket from 'ws';

export class GnaniSTT {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.baseUrl = 'wss://api.vachana.ai/stt/v3/stream';
  }

  async connect(options = {}) {
    const {
      model = 'prisma-v3.0',
      languageCode = 'indic-auto',
      languageCandidates = 'hi-IN,en-IN',
      format = 'codemix',
      sampleRate = '16000',
      keywords = []
    } = options;

    // Correct Gnani API header names per documentation
    const headers = {
      'x-api-key-id': this.apiKey,
      'x-model': model,
      'lang_code': languageCode,
      'x-language-candidates': languageCandidates,
      'x-format': format,
      'x-sample-rate': sampleRate,
      'x-enable-itn': 'true'
    };

    // Add keyword boosting for kirana/shop terms
    const defaultKeywords = [
      'udhaar', 'udhar', 'khata', 'payment', 'jama', 'baaki',
      'rupay', 'rupee', 'paisa', 'credit', 'diya', 'liya',
      'kal', 'parso', 'aaj', 'total', 'hisaab',
      ...keywords
    ];
    headers['x-keywords'] = JSON.stringify(defaultKeywords);

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.baseUrl, {
        headers,
        perMessageDeflate: false
      });

      ws.on('open', () => {
        console.log('[Gnani STT] Connected to Prisma v3.0 (codemix mode)');
        resolve(ws);
      });

      ws.on('error', (err) => {
        console.error('[Gnani STT] Connection error:', err.message);
        reject(err);
      });

      // Auto-timeout after 30s if not connected
      setTimeout(() => {
        if (ws.readyState !== WebSocket.OPEN) {
          ws.close();
          reject(new Error('STT connection timeout'));
        }
      }, 30000);
    });
  }
}

