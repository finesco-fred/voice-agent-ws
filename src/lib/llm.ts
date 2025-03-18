import { ChatCompletionRequestMessage } from "./types";

const SYSTEM_PROMPT = `You are an expert interviewer for Finesco, the world's best way of accessing proprietary information.
Your goal is to extract valuable domain knowledge from the user by asking thoughtful, relevant questions.

INTERVIEW APPROACH:
- Start with open-ended questions about their professional background and expertise
- Focus on their professional experience, specialized knowledge, and insights
- Be professional but conversational in tone
- Ask follow-up questions to go deeper when the user shares something interesting
- Avoid generic questions and instead tailor your questions based on what you learn about the user's expertise

QUESTION TECHNIQUES:
- Use the "why" and "how" technique to uncover deeper insights
- Ask for specific examples when they mention experiences
- Explore their decision-making processes
- Inquire about challenges they've faced and how they overcame them
- Probe for industry trends and future predictions they might have insights on

CONVERSATION MANAGEMENT:
- Keep responses concise but engaging
- Show genuine interest in their experience
- Guide the conversation naturally through their professional background, achievements, and industry insights
- If they mention a technical concept, ask them to elaborate on it
- If they reference a project, explore the details, challenges, and outcomes

HANDLING NONSENSICAL INPUT:
- If the user sends random characters, gibberish, or clearly non-meaningful content, DO NOT provide a positive or substantive response
- For nonsensical inputs, politely redirect the conversation by saying: "I'm having trouble understanding your last message. Could you share more about your professional background or expertise?"
- If the user continues with nonsensical inputs, maintain a professional tone but firmly refocus: "To make this conversation valuable, I need to learn about your professional experience. Could you tell me about your role or industry?"
- Never pretend to understand meaningless input
- Do not engage with or build upon content that appears to be random keystrokes or test messages

AVOID:
- Don't ask multiple questions at once
- Don't interrupt their train of thought
- Don't make assumptions about their expertise
- Don't rush through topics superficially
- Don't respond positively to gibberish or random characters`;

/**
 * Stream tokens from the OpenRouter API
 * @param messages Array of chat messages
 * @param apiKey OpenRouter API key
 * @param model Model to use (defaults to 'openai/gpt-4o')
 * @param onToken Callback function that receives each token as it's generated
 * @param onComplete Optional callback function called when streaming is complete
 * @param onError Optional callback function for handling errors
 * @returns A function that can be called to cancel the stream
 */
export const streamLLMResponse = async ({
  messages,
  model = "openai/gpt-4o",
  onToken,
  onComplete,
  onError,
}: {
  messages: ChatCompletionRequestMessage[];
  model?: string;
  onToken: (token: string) => void;
  onComplete?: (fullText: string) => void;
  onError?: (error: Error) => void;
}) => {
  let fullText = "";
  let controller: AbortController | null = new AbortController();
  let apiKey = process.env.OPENROUTER_API_KEY;
  let _messages = [
    {
      role: "system",
      content: SYSTEM_PROMPT,
    },
    ...messages,
  ];

  try {
    const response = await fetch(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: _messages,
          stream: true,
        }),
        signal: controller.signal,
      },
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API request failed: ${response.status} ${errorText}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("Response body is not readable");
    }

    const decoder = new TextDecoder();
    let buffer = "";

    const readChunk = async (): Promise<void> => {
      const { done, value } = await reader.read();

      if (done) {
        if (onComplete) {
          onComplete(fullText);
        }
        return;
      }

      // Append new chunk to buffer
      buffer += decoder.decode(value, { stream: true });

      // Process complete lines from buffer
      while (true) {
        const lineEnd = buffer.indexOf("\n");
        if (lineEnd === -1) break;

        const line = buffer.slice(0, lineEnd).trim();
        buffer = buffer.slice(lineEnd + 1);

        if (line.startsWith("data: ")) {
          const data = line.slice(6);

          if (data === "[DONE]") {
            if (onComplete) {
              onComplete(fullText);
            }
            return;
          }

          try {
            const parsed = JSON.parse(data);
            const content = parsed.choices[0].delta.content;

            if (content) {
              onToken(content);
              fullText += content;
            }
          } catch (e) {
            // Ignore invalid JSON
          }
        }
      }

      // Continue reading
      return readChunk();
    };

    // Start reading
    readChunk().catch((error) => {
      if (onError && error.name !== "AbortError") {
        onError(error);
      }
    });

    // Return a function to cancel the stream
    return () => {
      if (controller) {
        controller.abort();
        controller = null;
      }
    };
  } catch (error) {
    if (onError && error instanceof Error) {
      onError(error);
    }
    // Return a no-op cancel function
    return () => {};
  }
};
