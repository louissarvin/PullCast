/**
 * /explain entrypoint. Grounded answer to a user question about a cert or
 * tokenId, with citations enforced after the model returns.
 *
 * Pipeline:
 *   1. Predictive-question regex -> early refusal (never calls Anthropic).
 *   2. Retriever -> gather sources from live APIs + corpus seeds.
 *   3. sources.length < 2 -> refuse (never calls Anthropic).
 *   4. assertTokenBudget -> refuse if daily budget exhausted.
 *   5. Anthropic Messages API call (non-streaming).
 *   6. recordTokenSpend (best effort).
 *   7. stripUnreferencedCitations -> enforceCitations -> appendDisclosureFooter.
 *   8. Return text + sources, or refusal with reason.
 */

import {
  AnthropicUnavailableError,
  getAnthropic,
  isAnthropicAvailable,
} from './client.ts';
import {
  AnthropicBudgetError,
  assertTokenBudget,
  recordTokenSpend,
} from './budget.ts';
import {
  appendDisclosureFooter,
  assertGroundingChunks,
  enforceCitations,
  stripUnreferencedCitations,
} from './citation-guard.ts';
import {
  buildExplainPrompt,
  PREDICTIVE_REFUSAL_TEXT,
  SYSTEM_EXPLAIN,
  UNCITED_REFUSAL,
} from './prompts.ts';
import {
  gatherSourcesForCert,
  gatherSourcesForTokenId,
  type Source,
} from './retriever.ts';
import { GROQ_MODEL } from '../../config/main-config.ts';
import { DISCLOSURE_TEXT_FULL } from '../disclosure/index.ts';

const LOG_PREFIX = '[explain]';

/**
 * Heuristic regex for predictive questions. Triggers BEFORE the Anthropic
 * call so we save tokens AND keep the refusal posture consistent.
 *
 * Patterns covered:
 *   - "should i (buy|sell|hold)"
 *   - "will <X> go (up|down)"
 *   - "price prediction"
 *   - "moonshot"
 *   - "guarantee"
 */
const PREDICTIVE_RX =
  /(should\s+i\s+(buy|sell|hold))|(will\s+.+\s+go\s+(up|down))|(price\s+prediction)|(moonshot)|(guarantee)/i;

export type ExplainSubject =
  | { kind: 'cert'; cert: string }
  | { kind: 'tokenId'; tokenId: string };

export interface ExplainResult {
  text: string;
  sources: Source[];
  refused?: { reason: string };
}

const refusal = (text: string, reason: string): ExplainResult => ({
  text: appendDisclosureFooter(text),
  sources: [],
  refused: { reason },
});

const isPredictive = (question: string): boolean => {
  return typeof question === 'string' && PREDICTIVE_RX.test(question);
};

/**
 * Estimate input tokens from the JSON-ish payload size. LLM billing runs at
 * ~4 chars/token for English; we use that constant so the pre-flight assertion
 * is in the right order of magnitude. The post-call `recordTokenSpend` uses
 * the SDK's reported usage which is authoritative.
 */
const estimateInputTokens = (prompt: string, sources: Source[]): number => {
  const sourcesLen = JSON.stringify(sources).length;
  const promptLen = prompt.length;
  return Math.ceil((sourcesLen + promptLen + SYSTEM_EXPLAIN.length) / 4);
};

/**
 * OpenAI-compatible chat completion response shape (Groq mirrors this).
 * Only the fields we consume are typed. `choices[0].message.content` is the
 * assistant text; `usage.prompt_tokens` + `usage.completion_tokens` feed the
 * budget ledger.
 */
interface ChatCompletionUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}
interface ChatCompletionChoice {
  message?: { role?: string; content?: string | null };
  finish_reason?: string;
}
interface ChatCompletionResponse {
  choices?: ChatCompletionChoice[];
  usage?: ChatCompletionUsage;
}

const extractText = (resp: ChatCompletionResponse): string => {
  const choices = Array.isArray(resp?.choices) ? resp.choices : [];
  const first = choices[0];
  const content = first?.message?.content;
  return typeof content === 'string' ? content.trim() : '';
};

export const explainAsk = async (input: {
  subject: ExplainSubject;
  question: string;
}): Promise<ExplainResult> => {
  const { subject, question } = input;
  const safeQuestion = typeof question === 'string' ? question.trim() : '';

  if (safeQuestion.length === 0) {
    return refusal(
      'Please provide a question. Example: /explain cert cert:PSA73628064 question:"Is this graded card desirable?"',
      'empty-question'
    );
  }

  // 1. Early predictive-question refusal (never calls Anthropic).
  if (isPredictive(safeQuestion)) {
    console.log(`${LOG_PREFIX} predictive refusal subject=${subject.kind}`);
    return refusal(PREDICTIVE_REFUSAL_TEXT, 'predictive-question');
  }

  // 2. Quick availability check so we render a clean message instead of a 500.
  if (!isAnthropicAvailable()) {
    return refusal(
      'AI is currently disabled on this deployment. Try /price or /listing.',
      'ai-disabled'
    );
  }

  // 3. Retrieve sources.
  let sources: Source[];
  try {
    sources =
      subject.kind === 'cert'
        ? await gatherSourcesForCert(subject.cert)
        : await gatherSourcesForTokenId(subject.tokenId);
  } catch (err) {
    console.error(`${LOG_PREFIX} retriever crashed:`, err);
    return refusal(
      'Could not load grounding data. Try again in a moment.',
      'retriever-error'
    );
  }

  const grounding = assertGroundingChunks(sources);
  if (!grounding.ok) {
    console.warn(`${LOG_PREFIX} insufficient sources=${sources.length}`);
    return refusal(grounding.refusal, grounding.reason);
  }

  // 4. Build prompt + budget check.
  const userPrompt = buildExplainPrompt({ question: safeQuestion, sources });
  const estimated = estimateInputTokens(userPrompt, sources);
  try {
    await assertTokenBudget(estimated);
  } catch (err) {
    if (err instanceof AnthropicBudgetError) {
      return refusal(err.message, err.kind);
    }
    console.error(`${LOG_PREFIX} budget check unexpected:`, err);
    return refusal('AI temporarily unavailable.', 'budget-error');
  }

  // 5. LLM call (Groq via OpenAI-compatible chat completions).
  let response: ChatCompletionResponse;
  try {
    const client = getAnthropic();
    response = (await client.chat.completions.create({
      model: GROQ_MODEL,
      max_tokens: 700,
      temperature: 0.3,
      messages: [
        { role: 'system', content: SYSTEM_EXPLAIN },
        { role: 'user', content: userPrompt },
      ],
    })) as unknown as ChatCompletionResponse;
  } catch (err) {
    if (err instanceof AnthropicUnavailableError) {
      return refusal('AI is currently disabled.', 'ai-disabled');
    }
    console.error(`${LOG_PREFIX} groq call failed:`, err);
    return refusal(
      'AI service is temporarily unavailable. Try again in a moment.',
      'groq-error'
    );
  }

  // 6. Record spend (best effort). Groq returns OpenAI-shape usage:
  //    prompt_tokens + completion_tokens (not Anthropic's input/output_tokens).
  const inputTokens = response.usage?.prompt_tokens ?? estimated;
  const outputTokens = response.usage?.completion_tokens ?? 0;
  recordTokenSpend(inputTokens, outputTokens).catch((err: unknown) => {
    console.warn(`${LOG_PREFIX} recordTokenSpend failed:`, err);
  });

  // 7. Post-process text.
  let text = extractText(response);
  if (text.length === 0) {
    return refusal(
      'AI returned an empty response. Try rephrasing your question.',
      'empty-response'
    );
  }
  text = stripUnreferencedCitations(text, sources);
  const enforce = enforceCitations(text, sources);
  if (!enforce.ok) {
    console.warn(`${LOG_PREFIX} enforce failed reason=${enforce.reason}`);
    return refusal(UNCITED_REFUSAL, `uncited-response:${enforce.reason ?? 'unknown'}`);
  }

  // 8. Append disclosure and return.
  const finalText = appendDisclosureFooter(text);
  console.log(
    `${LOG_PREFIX} ok subject=${subject.kind} cited=${enforce.citedSourceIds.join(',')} input=${inputTokens} output=${outputTokens}`
  );
  return { text: finalText, sources };
};

/**
 * Re-export the disclosure constant so route handlers can compare against it
 * without reaching into the disclosure module again.
 */
export { DISCLOSURE_TEXT_FULL };
