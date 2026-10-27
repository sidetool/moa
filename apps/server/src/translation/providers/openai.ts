import { ApiFailure } from '../../util.js';
import { validModel } from '../endpoint.js';

// Encode OpenAI-compatible chat requests and decode their responses.
export const openai = {
  authorization: (key: string): Record<string, string> => ({ Authorization: `Bearer ${key}` }),
  modelsPath: '/models',
  models(data: any): string[] {
    if (!Array.isArray(data?.data)) throw new ApiFailure(502, 'translation-invalid-response');
    return data.data.map((model: any) => model?.id).filter(validModel).sort();
  },
  request(model: string, instruction: string, content: string) {
    return {
      path: '/chat/completions',
      body: {
        model,
        messages: [{ role: 'system', content: instruction }, { role: 'user', content }],
        response_format: { type: 'json_object' },
      },
    };
  },
  translation(data: any) {
    const candidate = data?.choices?.[0];
    if (candidate?.finish_reason !== 'stop') throw new ApiFailure(502, 'translation-incomplete');
    try {
      return JSON.parse(candidate.message.content);
    } catch {
      throw new ApiFailure(502, 'translation-invalid-response');
    }
  },
};
