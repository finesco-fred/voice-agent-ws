// types.ts
export interface ChatCompletionRequestMessage {
  role: 'system' | 'user' | 'assistant' | 'function';
  content: string;
  name?: string;
}
