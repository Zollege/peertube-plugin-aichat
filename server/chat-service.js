const openaiService = require('./openai-service')

let logger = null
let settingsManager = null
let peertubeHelpers = null

function initialize(services) {
  logger = services.logger
  settingsManager = services.settingsManager
  peertubeHelpers = services.peertubeHelpers
}

async function handleChatMessage(videoId, videoUuid, message, userId) {
  if (!openaiService.isInitialized()) {
    throw new Error('AI service not configured')
  }

  // Get relevant context from vector database
  const context = await getVideoContext(videoUuid, message)

  // Generate response
  const response = await generateChatResponse(message, context, videoId, userId)

  return response
}

async function getVideoContext(videoUuid, query) {
  if (!openaiService.isInitialized()) return null

  try {
    const sequelize = peertubeHelpers.database.sequelize

    // Generate embedding for the query
    const queryEmbedding = await openaiService.generateEmbedding(query)

    // Find similar chunks using pgvector
    const [similarChunks] = await sequelize.query(`
      SELECT content, start_time, end_time,
             embedding <-> $2::vector as distance
      FROM plugin_ai_video_embeddings
      WHERE video_uuid = $1 AND embedding IS NOT NULL
      ORDER BY distance
      LIMIT 5;
    `, {
      bind: [videoUuid, `[${queryEmbedding.join(',')}]`]
    })

    // Get relevant snapshots based on the time ranges of similar chunks
    let snapshots = []
    if (similarChunks.length > 0) {
      const minTime = Math.min(...similarChunks.map(c => c.start_time))
      const maxTime = Math.max(...similarChunks.map(c => c.end_time))

      const [relevantSnapshots] = await sequelize.query(`
        SELECT timestamp, description
        FROM plugin_ai_video_snapshots
        WHERE video_uuid = $1
          AND description IS NOT NULL
          AND timestamp >= $2
          AND timestamp <= $3
        ORDER BY timestamp
        LIMIT 10;
      `, {
        bind: [videoUuid, minTime, maxTime]
      })

      snapshots = relevantSnapshots
    }

    return {
      transcriptChunks: similarChunks,
      snapshots: snapshots
    }
  } catch (error) {
    logger.error('Failed to get video context:', error)
    return null
  }
}

async function generateChatResponse(message, context, videoId, userId) {
  const systemPrompt = await settingsManager.getSetting('system-prompt')
  const model = await settingsManager.getSetting('openai-model')
  const maxTokens = parseInt(await settingsManager.getSetting('max-tokens') || '1000')

  // Build context message
  let contextMessage = ''

  if (context) {
    if (context.transcriptChunks && context.transcriptChunks.length > 0) {
      contextMessage += '\n\nRelevant transcript sections:\n'
      context.transcriptChunks.forEach(chunk => {
        const startTime = formatTime(chunk.start_time)
        const endTime = formatTime(chunk.end_time)
        contextMessage += `[${startTime} - ${endTime}]: ${chunk.content}\n`
      })
    }

    if (context.snapshots && context.snapshots.length > 0) {
      contextMessage += '\n\nVideo visual descriptions:\n'
      context.snapshots.forEach(snapshot => {
        const time = formatTime(snapshot.timestamp)
        contextMessage += `[${time}]: ${snapshot.description}\n`
      })
    }
  }

  // Build the full user message
  const fullUserMessage = contextMessage
    ? `Context about the video:${contextMessage}\n\nUser question: ${message}`
    : `User question: ${message}`

  // Generate response using OpenAI
  const aiResponse = await openaiService.generateChatResponse(
    systemPrompt,
    fullUserMessage,
    context,
    model,
    maxTokens
  )

  const responseContent = aiResponse.content

  // Extract timestamps from response
  const timestamps = extractTimestamps(responseContent)

  // Save to chat history
  const sequelize = peertubeHelpers.database.sequelize
  await sequelize.query(`
    INSERT INTO plugin_ai_chat_sessions (video_id, user_id, message, response)
    VALUES ($1, $2, $3, $4);
  `, {
    bind: [videoId, userId, message, responseContent]
  })

  // Track API usage
  if (aiResponse.usage) {
    await sequelize.query(`
      INSERT INTO plugin_ai_api_usage (user_id, endpoint, tokens_used)
      VALUES ($1, $2, $3);
    `, {
      bind: [userId, 'chat', aiResponse.usage.total_tokens]
    })
  }

  return {
    response: responseContent,
    timestamps
  }
}

async function getChatHistory(videoId, userId) {
  const sequelize = peertubeHelpers.database.sequelize

  const [history] = await sequelize.query(`
    SELECT message, response, created_at
    FROM plugin_ai_chat_sessions
    WHERE video_id = $1 AND ($2::int IS NULL OR user_id = $2)
    ORDER BY created_at DESC
    LIMIT 50;
  `, {
    bind: [videoId, userId || null]
  })

  return history
}

function formatTime(seconds) {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const secs = Math.floor(seconds % 60)

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
  }
  return `${minutes}:${secs.toString().padStart(2, '0')}`
}

function extractTimestamps(text) {
  const timestamps = []
  const regex = /\[(\d{1,2}:\d{2}(?::\d{2})?)\]/g
  let match

  while ((match = regex.exec(text)) !== null) {
    const timeStr = match[1]
    const parts = timeStr.split(':')
    let seconds = 0

    if (parts.length === 3) {
      seconds = parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseInt(parts[2])
    } else if (parts.length === 2) {
      seconds = parseInt(parts[0]) * 60 + parseInt(parts[1])
    }

    timestamps.push({
      display: match[0],
      seconds: seconds
    })
  }

  return timestamps
}

module.exports = {
  initialize,
  handleChatMessage,
  getChatHistory
}