import config from '../config.js';

/**
 * Claude, through whichever provider is configured (AI_PROVIDER).
 *
 *   anthropic — Anthropic's own API. One key, nothing else to set up.
 *   bedrock   — Claude on Amazon Bedrock. AWS runs inference with no operator
 *               access and does not store prompts or share them with the model
 *               provider. Credentials come from the standard AWS chain; in
 *               production that is AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY
 *               injected from Secret Manager.
 *
 * Nothing else in the app knows which one is in use, and the SDK for the
 * provider that isn't configured is never loaded.
 *
 * Both paths ask for JSON through one forced tool call: Bedrock has no
 * structured outputs, and keeping the two identical means switching provider
 * cannot change what the model returns. Callers still validate what comes back
 * — a tool schema guides the model, it does not guarantee the shape.
 */

/** An error every further call in this run would hit the same way. */
const fatal = (message) => Object.assign(new Error(message), { fatalLlm: true });

const PROVIDERS = {
  anthropic: {
    async connect() {
      const { apiKey, model } = config.ai.anthropic;
      if (!apiKey) throw fatal('ANTHROPIC_API_KEY is not set');
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      return { client: new Anthropic({ apiKey }), model };
    },
    explain(err) {
      const status = err?.status;
      const message = err?.message || '';
      if (status === 401) return fatal('The Anthropic API key is invalid or revoked');
      if (status === 403) return fatal('This Anthropic API key is not permitted to call the model');
      if (status === 400 && /credit balance|billing/i.test(message)) return fatal('The Anthropic account is out of credit');
      if (status === 429) return new Error('Anthropic rate limit hit — this will be retried on the next poll');
      return new Error(`Claude call failed: ${message || err}`);
    },
  },

  bedrock: {
    async connect() {
      const { region, model } = config.ai.bedrock;
      const { AnthropicBedrockMantle } = await import('@anthropic-ai/bedrock-sdk');
      return { client: new AnthropicBedrockMantle({ awsRegion: region }), model };
    },
    explain(err) {
      const status = err?.status;
      if (status === 401) return fatal('AWS credentials for Bedrock are invalid or revoked');
      if (status === 403) {
        return fatal('These AWS credentials are not permitted to call Bedrock (they need bedrock-mantle:CreateInference on the Claude model)');
      }
      if (status === 429) return new Error('Bedrock rate limit hit — this will be retried on the next poll');
      return new Error(`Bedrock call failed: ${err?.message || err}`);
    },
  },
};

/** The configured provider, or a fatal error naming what AI_PROVIDER accepts. */
export function providerFor(name = config.ai.provider) {
  const provider = PROVIDERS[name];
  if (!provider) throw fatal(`AI_PROVIDER must be one of ${Object.keys(PROVIDERS).join(', ')}, not "${name}"`);
  return provider;
}

// One client per process. A failed connection is not cached, so a fixed key or
// a restored role works on the next call without a restart.
let connecting = null;

/** Drops the cached client, after the Claude key was changed in the app. */
export function resetClient() {
  connecting = null;
}
function connect(provider) {
  connecting ||= Promise.resolve(provider.connect()).catch((err) => {
    connecting = null;
    throw err;
  });
  return connecting;
}

/**
 * Asks the model to fill in `schema` and returns the object it produced.
 * Infrastructure failures throw, so a caller can always tell "the model decided"
 * from "we never managed to ask".
 */
export async function callForJson({ prompt, schema, toolName, description, maxTokens = 1024 }) {
  const provider = providerFor();
  let response;
  try {
    const { client, model } = await connect(provider);
    response = await client.messages.create({
      model,
      max_tokens: maxTokens,
      tools: [{ name: toolName, description, input_schema: schema }],
      tool_choice: { type: 'tool', name: toolName },
      messages: [{ role: 'user', content: prompt }],
    });
  } catch (err) {
    throw err?.fatalLlm ? err : provider.explain(err);
  }

  const call = response.content.find((b) => b.type === 'tool_use' && b.name === toolName);
  if (!call || typeof call.input !== 'object' || call.input === null) {
    throw new Error(`Model did not return ${toolName} (stop_reason: ${response.stop_reason})`);
  }
  return call.input;
}

/**
 * Errors after which every further call in the same run would fail the same way.
 * The message check covers an error that was re-wrapped on its way up.
 */
export const isFatalLlmError = (err) => Boolean(err?.fatalLlm)
  || /invalid or revoked|not permitted to call|out of credit|is not set/i.test(err?.message || '');

/** Drops the cached client. Tests only. */
export function __resetClientForTests() {
  connecting = null;
}
