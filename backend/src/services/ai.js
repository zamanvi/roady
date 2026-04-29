const OpenAI = require('openai');

let client = null;
function getClient() {
  if (!process.env.OPENAI_API_KEY) return null;
  if (!client) client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return client;
}

async function analyzeJobPhoto(base64DataUrl) {
  const ai = getClient();
  if (!ai) return null;

  try {
    const response = await ai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{
        role: 'user',
        content: [
          {
            type: 'text',
            text: `You are a roadside assistance AI dispatcher. Analyze this vehicle problem photo.
Return ONLY valid JSON (no markdown):
{
  "serviceType": "tow|flat_tire|dead_battery|lockout|fuel|accident|other",
  "description": "max 15 words describing the exact situation",
  "urgency": "high|medium|low",
  "priceMin": number,
  "priceMax": number
}
Price in USD. Base price on US market rates: tow $75-$150, flat tire $50-$100, battery $60-$120, lockout $50-$100, fuel $40-$80.`
          },
          {
            type: 'image_url',
            image_url: { url: base64DataUrl, detail: 'low' }
          }
        ]
      }],
      max_tokens: 150,
    });

    const text = response.choices[0].message.content.trim();
    return JSON.parse(text);
  } catch (err) {
    console.warn('AI photo analysis failed:', err.message);
    return null;
  }
}

module.exports = { analyzeJobPhoto };
