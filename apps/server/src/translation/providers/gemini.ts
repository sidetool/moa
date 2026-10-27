import { ApiFailure } from '../../util.js';
import { validModel } from '../endpoint.js';

// Encode Gemini requests and decode its model and generation responses.
export const gemini = {
  authorization: (key: string): Record<string, string> => ({ 'x-goog-api-key': key }),
  modelsPath: '/models?pageSize=1000',
  models(data: any): string[] {
    if (!Array.isArray(data?.models)) throw new ApiFailure(502, 'translation-invalid-response');
    return data.models
      .filter((model: any) => model?.supportedGenerationMethods?.includes('generateContent'))
      .map((model: any) => String(model.name || '').replace(/^models\//, ''))
      .filter((model: string) => validModel(model) && !/(image|tts|audio|live|embedding|robotics)/i.test(model))
      .sort();
  },
  request(model: string, instruction: string, content: string) {
    return {
      path: `/models/${encodeURIComponent(model)}:generateContent`,
      body: {
        systemInstruction: { parts: [{ text: instruction }] },
        contents: [{ role: 'user', parts: [{ text: content }] }],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 16384,
          responseMimeType: 'application/json',
          responseSchema: {
            type: 'OBJECT',
            properties: {
              lines: {
                type: 'ARRAY',
                items: {
                  type: 'OBJECT',
                  properties: { id: { type: 'INTEGER' }, text: { type: 'STRING' } },
                  required: ['id', 'text'],
                },
              },
            },
            required: ['lines'],
          },
        },
      },
    };
  },
  translation(data: any) {
    const candidate = data?.candidates?.[0];
    if (candidate?.finishReason !== 'STOP') throw new ApiFailure(502, 'translation-incomplete');
    try {
      return JSON.parse(candidate.content.parts
        .filter((part: any) => typeof part.text === 'string' && !part.thought)
        .map((part: any) => part.text).join(''));
    } catch {
      throw new ApiFailure(502, 'translation-invalid-response');
    }
  },
};
