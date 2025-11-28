const openaiService = require('./openai-service')
const databaseService = require('./database-service')

let rawLogger = null
let settingsManager = null
let peertubeHelpers = null

// Wrapper logger that adds 'aichat' tag to all messages
const logger = {
  info: (msg, meta) => rawLogger?.info(msg, { tags: ['aichat'], ...meta }),
  warn: (msg, meta) => rawLogger?.warn(msg, { tags: ['aichat'], ...meta }),
  error: (msg, meta) => rawLogger?.error(msg, { tags: ['aichat'], ...meta }),
  debug: (msg, meta) => rawLogger?.debug(msg, { tags: ['aichat'], ...meta })
}

function initialize(services) {
  rawLogger = services.logger
  settingsManager = services.settingsManager
  peertubeHelpers = services.peertubeHelpers
}

async function handleChatMessage(videoId, videoUuid, message, userId) {
  if (!openaiService.isInitialized()) {
    throw new Error('AI service not configured')
  }

  // Get current video metadata
  let videoMetadata = null
  try {
    const videoData = await peertubeHelpers.videos.loadByIdOrUUID(videoUuid)
    if (videoData) {
      videoMetadata = {
        title: videoData.name || 'Unknown',
        description: videoData.description || '',
        channel: videoData.VideoChannel?.name || '',
        duration: videoData.duration || 0
      }
    }
  } catch (error) {
    logger.warn('Failed to load video metadata:', error.message)
  }

  // Get relevant context from vector database
  const context = await getVideoContext(videoUuid, message)

  // Add video metadata to context
  if (context) {
    context.metadata = videoMetadata
  }

  // Get related videos for recommendations
  const relatedVideos = await getRelatedVideos(videoUuid, 10)
  if (context) {
    context.relatedVideos = relatedVideos
  }

  // Get conversation history for this specific video (last 20 exchanges)
  const history = await getChatHistory(videoId, userId)

  // Generate response with history
  const response = await generateChatResponse(message, context, videoId, videoUuid, userId, history)

  return response
}

async function getVideoContext(videoUuid, query) {
  if (!openaiService.isInitialized()) return null

  try {
    // Generate embedding for the query
    const queryEmbedding = await openaiService.generateEmbedding(query)

    // Find similar chunks using pgvector or fallback
    const similarChunks = await databaseService.findSimilarChunks(videoUuid, queryEmbedding, 5)

    // Get relevant snapshots based on the time ranges of similar chunks
    let snapshots = []
    if (similarChunks.length > 0) {
      const minTime = Math.min(...similarChunks.map(c => c.startTime || c.start_time || 0))
      const maxTime = Math.max(...similarChunks.map(c => c.endTime || c.end_time || 0))

      snapshots = await databaseService.getVideoSnapshots(videoUuid, minTime, maxTime)
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

async function getRelatedVideos(currentVideoUuid, limit = 10) {
  try {
    // Use PeerTube's database helper to query other public videos
    if (peertubeHelpers.database?.query) {
      const result = await peertubeHelpers.database.query(`
        SELECT v.uuid, v.name, v.description, vc.name as channel_name
        FROM video v
        JOIN "videoChannel" vc ON v."channelId" = vc.id
        WHERE v.uuid != $1
          AND v.state = 1
          AND v.privacy = 1
        ORDER BY v."publishedAt" DESC
        LIMIT $2
      `, { bind: [currentVideoUuid, limit] })

      // Debug: Log the result structure
      logger.info(`getRelatedVideos raw result type: ${typeof result}`)
      logger.info(`getRelatedVideos raw result: ${JSON.stringify(result)?.slice(0, 500)}`)

      // Handle different result formats from PeerTube's query helper
      let videos = []
      if (Array.isArray(result)) {
        // Result might be [rows, metadata] from Sequelize
        videos = Array.isArray(result[0]) ? result[0] : result
      } else if (result?.rows) {
        videos = result.rows
      }

      logger.info(`getRelatedVideos returning ${videos.length} videos`)
      return videos
    }
    return []
  } catch (error) {
    logger.warn('Failed to get related videos:', error.message)
    return []
  }
}

async function generateChatResponse(message, context, videoId, videoUuid, userId, history = []) {
  const systemPrompt = await settingsManager.getSetting('system-prompt')
  const model = await settingsManager.getSetting('openai-model')
  const maxTokens = parseInt(await settingsManager.getSetting('max-tokens') || '1000')

  // Build context message
  let contextMessage = ''

  // Always include current video metadata first
  if (context?.metadata) {
    contextMessage += 'CURRENT VIDEO:\n'
    contextMessage += `Title: ${context.metadata.title}\n`
    if (context.metadata.channel) {
      contextMessage += `Channel: ${context.metadata.channel}\n`
    }
    contextMessage += `Duration: ${formatTime(context.metadata.duration)}\n`
    if (context.metadata.description) {
      contextMessage += `Description: ${context.metadata.description.slice(0, 500)}\n`
    }
    contextMessage += '\n'
  }

  // Add transcript chunks if available
  if (context?.transcriptChunks?.length > 0) {
    contextMessage += 'Relevant transcript sections:\n'
    context.transcriptChunks.forEach(chunk => {
      const startTime = formatTime(chunk.startTime || chunk.start_time)
      const endTime = formatTime(chunk.endTime || chunk.end_time)
      contextMessage += `[${startTime} - ${endTime}]: ${chunk.content}\n`
    })
    contextMessage += '\n'
  }

  // Add visual descriptions if available
  if (context?.snapshots?.length > 0) {
    contextMessage += 'Video visual descriptions:\n'
    context.snapshots.forEach(snapshot => {
      const time = formatTime(snapshot.timestamp)
      contextMessage += `[${time}]: ${snapshot.description || 'Visual at this timestamp'}\n`
    })
    contextMessage += '\n'
  }

  // Add related videos for recommendations
  if (context?.relatedVideos?.length > 0) {
    contextMessage += 'OTHER AVAILABLE VIDEOS (for recommendations):\n'
    context.relatedVideos.forEach(video => {
      const desc = video.description ? `: ${video.description.slice(0, 100)}...` : ''
      contextMessage += `- "${video.name}" by ${video.channel_name || 'Unknown'}${desc}\n`
    })
    contextMessage += '\n'
  }

  // Build the full user message
  const fullUserMessage = contextMessage
    ? `Context:\n${contextMessage}\nUser question: ${message}`
    : `User question: ${message}`

  // Prepare history (last 20 exchanges, in chronological order)
  const recentHistory = history.slice(-20).reverse()

  // Generate response using OpenAI with conversation history
  logger.info(`Calling OpenAI for chat, model: ${model}, maxTokens: ${maxTokens}`)
  logger.info(`Context: transcripts=${context?.transcriptChunks?.length || 0}, snapshots=${context?.snapshots?.length || 0}, related=${context?.relatedVideos?.length || 0}`)

  const aiResponse = await openaiService.generateChatResponse(
    systemPrompt,
    fullUserMessage,
    context,
    model,
    maxTokens,
    recentHistory
  )

  logger.info(`AI response received, content length: ${aiResponse?.content?.length || 0}`)

  const responseContent = aiResponse.content

  // Extract timestamps from response
  const timestamps = extractTimestamps(responseContent)

  // Save to chat history
  await databaseService.saveChatMessage(videoId, videoUuid, userId, message, responseContent)

  // Track API usage
  if (aiResponse.usage) {
    await databaseService.trackAPIUsage(userId, 'chat', aiResponse.usage.total_tokens)
  }

  return {
    response: responseContent,
    timestamps
  }
}

async function getChatHistory(videoId, userId) {
  return await databaseService.getChatHistory(videoId, userId)
}

function formatTime(seconds) {
  if (seconds === null || seconds === undefined) {
    return '0:00'
  }

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