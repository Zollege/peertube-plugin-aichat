const OpenAI = require('openai')

let openaiClient = null
let logger = null
let settingsManager = null

async function initialize(services) {
  logger = services.logger
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

  const response = await openaiClient.chat.completions.create({
    model: 'gpt-4-vision-preview',
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

async function generateChatResponse(systemPrompt, userMessage, context, model, maxTokens) {
  if (!openaiClient) {
    throw new Error('OpenAI client not initialized')
  }

  const completion = await openaiClient.chat.completions.create({
    model: model || 'gpt-4',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage }
    ],
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