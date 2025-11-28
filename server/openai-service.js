const OpenAI = require('openai')

let openaiClient = null
let rawLogger = null
let settingsManager = null

// Wrapper logger that adds 'aichat' tag to all messages
const logger = {
  info: (msg, meta) => rawLogger?.info(msg, { tags: ['aichat'], ...meta }),
  warn: (msg, meta) => rawLogger?.warn(msg, { tags: ['aichat'], ...meta }),
  error: (msg, meta) => rawLogger?.error(msg, { tags: ['aichat'], ...meta }),
  debug: (msg, meta) => rawLogger?.debug(msg, { tags: ['aichat'], ...meta })
}

// Helper to get model-specific parameters
// Newer models (gpt-4o, gpt-4.1, gpt-5, o1, o3) use max_completion_tokens
// Older models (gpt-4, gpt-4-turbo, gpt-3.5) use max_tokens
// Some models (o1, o3, gpt-5) don't support custom temperature
function getModelParams(model, tokens, temperature = 0.7) {
  const newTokenPrefixes = ['gpt-4o', 'gpt-4.1', 'gpt-5', 'o1', 'o3']
  const noTemperaturePrefixes = ['o1', 'o3', 'gpt-5']

  const usesNewTokenParam = newTokenPrefixes.some(prefix => model.startsWith(prefix))
  const noTemperatureSupport = noTemperaturePrefixes.some(prefix => model.startsWith(prefix))

  const params = {}

  // Token parameter
  if (usesNewTokenParam) {
    params.max_completion_tokens = tokens
  } else {
    params.max_tokens = tokens
  }

  // Temperature (not supported by reasoning models and gpt-5)
  if (!noTemperatureSupport) {
    params.temperature = temperature
  }

  return params
}

async function initialize(services) {
  rawLogger = services.logger
  settingsManager = services.settingsManager

  const apiKey = await settingsManager.getSetting('openai-api-key')

  if (!apiKey) {
    logger.warn('OpenAI API key not configured')
    return
  }

  try {
    openaiClient = new OpenAI({
      apiKey: apiKey
    })
    logger.info('OpenAI client initialized')
  } catch (error) {
    logger.error('Failed to initialize OpenAI client:', error)
  }
}

async function generateEmbedding(text) {
  if (!openaiClient) {
    throw new Error('OpenAI client not initialized')
  }

  const response = await openaiClient.embeddings.create({
    model: 'text-embedding-3-small',
    input: text
  })

  return response.data[0].embedding
}

async function analyzeImage(base64Image, prompt) {
  if (!openaiClient) {
    throw new Error('OpenAI client not initialized')
  }

  // Get the configured model (all current models support vision)
  const model = await settingsManager.getSetting('openai-model') || 'gpt-4.1-mini'

  const response = await openaiClient.chat.completions.create({
    model: model,
    messages: [
      {
        role: 'system',
        content: prompt || 'Describe what you see in this video frame concisely. Focus on key visual elements, text, people, actions, and context.'
      },
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: {
              url: `data:image/jpeg;base64,${base64Image}`
            }
          }
        ]
      }
    ],
    ...getModelParams(model, 150)
  })

  return response.choices[0].message.content
}

async function generateChatResponse(systemPrompt, userMessage, context, model, maxTokens, history = []) {
  if (!openaiClient) {
    throw new Error('OpenAI client not initialized')
  }

  // Build messages array with system prompt first
  const messages = [
    { role: 'system', content: systemPrompt }
  ]

  // Add conversation history (already in chronological order from caller)
  for (const entry of history) {
    messages.push({ role: 'user', content: entry.message })
    messages.push({ role: 'assistant', content: entry.response })
  }

  // Add current user message
  messages.push({ role: 'user', content: userMessage })

  const selectedModel = model || 'gpt-4'
  const modelParams = getModelParams(selectedModel, maxTokens || 1000, 0.7)

  logger.info(`Calling OpenAI with model: ${selectedModel}`)
  logger.info(`Messages count: ${messages.length}, params: ${JSON.stringify(modelParams)}`)

  const completion = await openaiClient.chat.completions.create({
    model: selectedModel,
    messages: messages,
    ...modelParams
  })

  logger.info(`OpenAI response received, choices: ${completion.choices?.length}`)

  const content = completion.choices[0]?.message?.content || ''

  if (!content) {
    logger.warn('OpenAI returned empty content')
    logger.warn(`Full response: ${JSON.stringify(completion)?.slice(0, 500)}`)
  } else {
    logger.info(`Response content (truncated): ${content.slice(0, 100)}...`)
  }

  return {
    content: content,
    usage: completion.usage
  }
}

function isInitialized() {
  return openaiClient !== null
}

module.exports = {
  initialize,
  generateEmbedding,
  analyzeImage,
  generateChatResponse,
  isInitialized
}