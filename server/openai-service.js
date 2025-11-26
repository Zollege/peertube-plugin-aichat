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
    max_tokens: 150
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

  const completion = await openaiClient.chat.completions.create({
    model: model || 'gpt-4',
    messages: messages,
    max_tokens: maxTokens || 1000,
    temperature: 0.7
  })

  return {
    content: completion.choices[0].message.content,
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