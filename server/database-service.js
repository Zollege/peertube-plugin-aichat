const { Client } = require('pg')
const pgvector = require('pgvector/pg')

let logger = null
let settingsManager = null
let storageManager = null
let dbClient = null
let isConnected = false

async function initialize(services) {
  logger = services.logger
  settingsManager = services.settingsManager
  storageManager = services.storageManager

  logger.info('Initializing AI Chat database service...')

  // Get database URL from settings
  const databaseUrl = await settingsManager.getSetting('database-url')

  if (!databaseUrl) {
    logger.warn('No database URL configured. Using fallback storage mode.')
    // Fall back to storage manager for basic functionality
    await initializeFallbackStorage()
    return
  }

  try {
    // Connect to PostgreSQL database
    dbClient = new Client({
      connectionString: databaseUrl,
      ssl: databaseUrl.includes('localhost') ? false : { rejectUnauthorized: false }
    })

    await dbClient.connect()
    isConnected = true
    logger.info('Connected to PostgreSQL database')

    // Register pgvector type
    await pgvector.registerType(dbClient)

    // Create tables with pgvector support
    await createTables()

    logger.info('Database tables initialized successfully')
  } catch (error) {
    logger.error('Failed to initialize database:', error)
    isConnected = false

    // Fall back to storage manager
    logger.info('Falling back to storage manager mode')
    await initializeFallbackStorage()
  }
}

async function createTables() {
  try {
    // Create pgvector extension
    await dbClient.query(`CREATE EXTENSION IF NOT EXISTS vector`)
    logger.info('pgvector extension created/verified')

    // Video embeddings table
    await dbClient.query(`
      CREATE TABLE IF NOT EXISTS plugin_ai_video_embeddings (
        id SERIAL PRIMARY KEY,
        video_id INTEGER NOT NULL,
        video_uuid VARCHAR(255) NOT NULL,
        chunk_index INTEGER NOT NULL,
        start_time FLOAT NOT NULL,
        end_time FLOAT NOT NULL,
        content TEXT,
        embedding vector(1536),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(video_uuid, chunk_index)
      )
    `)

    // Video snapshots table
    await dbClient.query(`
      CREATE TABLE IF NOT EXISTS plugin_ai_video_snapshots (
        id SERIAL PRIMARY KEY,
        video_id INTEGER NOT NULL,
        video_uuid VARCHAR(255) NOT NULL,
        timestamp FLOAT NOT NULL,
        file_path TEXT NOT NULL,
        description TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(video_uuid, timestamp)
      )
    `)

    // Chat sessions table
    await dbClient.query(`
      CREATE TABLE IF NOT EXISTS plugin_ai_chat_sessions (
        id SERIAL PRIMARY KEY,
        video_id INTEGER NOT NULL,
        user_id INTEGER,
        message TEXT NOT NULL,
        response TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `)

    // Processing queue table
    await dbClient.query(`
      CREATE TABLE IF NOT EXISTS plugin_ai_processing_queue (
        id SERIAL PRIMARY KEY,
        video_id INTEGER NOT NULL,
        video_uuid VARCHAR(255) NOT NULL,
        status VARCHAR(50) DEFAULT 'pending',
        error_message TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        processed_at TIMESTAMP,
        UNIQUE(video_uuid)
      )
    `)

    // API usage table
    await dbClient.query(`
      CREATE TABLE IF NOT EXISTS plugin_ai_api_usage (
        id SERIAL PRIMARY KEY,
        user_id INTEGER,
        endpoint VARCHAR(255),
        tokens_used INTEGER,
        cost DECIMAL(10, 6),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `)

    // Create indexes for better performance
    await dbClient.query(`
      CREATE INDEX IF NOT EXISTS idx_embeddings_video ON plugin_ai_video_embeddings(video_uuid);
      CREATE INDEX IF NOT EXISTS idx_embeddings_vector ON plugin_ai_video_embeddings USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
      CREATE INDEX IF NOT EXISTS idx_snapshots_video ON plugin_ai_video_snapshots(video_uuid);
      CREATE INDEX IF NOT EXISTS idx_sessions_video ON plugin_ai_chat_sessions(video_id);
      CREATE INDEX IF NOT EXISTS idx_queue_status ON plugin_ai_processing_queue(status);
    `)

    logger.info('All database tables and indexes created successfully')
  } catch (error) {
    logger.error('Error creating tables:', error)
    throw error
  }
}

async function initializeFallbackStorage() {
  // Initialize storage keys for fallback mode
  const storageKeys = [
    'video_embeddings',
    'video_snapshots',
    'chat_sessions',
    'processing_queue',
    'api_usage'
  ]

  for (const key of storageKeys) {
    const data = await storageManager.getData(key)
    if (!data) {
      await storageManager.storeData(key, {})
      logger.info(`Initialized fallback storage key: ${key}`)
    }
  }
}

// Video embeddings functions
async function saveVideoEmbedding(videoUuid, videoId, chunkIndex, data) {
  if (!isConnected) {
    return await saveVideoEmbeddingFallback(videoUuid, chunkIndex, data)
  }

  try {
    const { startTime, endTime, content, embedding } = data

    // Handle null embeddings - pgvector.toSql expects an array
    const embeddingValue = embedding ? pgvector.toSql(embedding) : null

    await dbClient.query(`
      INSERT INTO plugin_ai_video_embeddings
        (video_id, video_uuid, chunk_index, start_time, end_time, content, embedding)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (video_uuid, chunk_index)
      DO UPDATE SET
        start_time = EXCLUDED.start_time,
        end_time = EXCLUDED.end_time,
        content = EXCLUDED.content,
        embedding = EXCLUDED.embedding
    `, [videoId, videoUuid, chunkIndex, startTime, endTime, content, embeddingValue])
  } catch (error) {
    logger.error('Error saving embedding:', error)
    throw error
  }
}

async function getVideoEmbeddings(videoUuid) {
  if (!isConnected) {
    return await getVideoEmbeddingsFallback(videoUuid)
  }

  try {
    const result = await dbClient.query(`
      SELECT chunk_index, start_time, end_time, content, embedding
      FROM plugin_ai_video_embeddings
      WHERE video_uuid = $1
      ORDER BY chunk_index
    `, [videoUuid])

    return result.rows.map(row => ({
      chunkIndex: row.chunk_index,
      startTime: row.start_time,
      endTime: row.end_time,
      content: row.content,
      embedding: pgvector.fromSql(row.embedding)
    }))
  } catch (error) {
    logger.error('Error getting embeddings:', error)
    return []
  }
}

// Find similar chunks using pgvector
async function findSimilarChunks(videoUuid, queryEmbedding, limit = 5) {
  if (!isConnected) {
    return await findSimilarChunksFallback(videoUuid, queryEmbedding, limit)
  }

  try {
    const result = await dbClient.query(`
      SELECT content, start_time, end_time,
             embedding <-> $2::vector as distance
      FROM plugin_ai_video_embeddings
      WHERE video_uuid = $1 AND embedding IS NOT NULL
      ORDER BY distance
      LIMIT $3
    `, [videoUuid, pgvector.toSql(queryEmbedding), limit])

    return result.rows.map(row => ({
      content: row.content,
      startTime: row.start_time,
      endTime: row.end_time,
      distance: row.distance
    }))
  } catch (error) {
    logger.error('Error finding similar chunks:', error)
    return []
  }
}

// Video snapshots functions
async function saveVideoSnapshot(videoUuid, videoId, timestamp, filePath, description) {
  if (!isConnected) {
    return await saveVideoSnapshotFallback(videoUuid, timestamp, filePath, description)
  }

  try {
    await dbClient.query(`
      INSERT INTO plugin_ai_video_snapshots
        (video_id, video_uuid, timestamp, file_path, description)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (video_uuid, timestamp)
      DO UPDATE SET
        file_path = EXCLUDED.file_path,
        description = EXCLUDED.description
    `, [videoId, videoUuid, timestamp, filePath, description])
  } catch (error) {
    logger.error('Error saving snapshot:', error)
  }
}

async function getVideoSnapshots(videoUuid, minTime = null, maxTime = null) {
  if (!isConnected) {
    return await getVideoSnapshotsFallback(videoUuid)
  }

  try {
    let query = `
      SELECT timestamp, file_path, description
      FROM plugin_ai_video_snapshots
      WHERE video_uuid = $1
    `
    const params = [videoUuid]

    if (minTime !== null && maxTime !== null) {
      query += ` AND timestamp >= $2 AND timestamp <= $3`
      params.push(minTime, maxTime)
    }

    query += ` ORDER BY timestamp`

    const result = await dbClient.query(query, params)
    return result.rows
  } catch (error) {
    logger.error('Error getting snapshots:', error)
    return []
  }
}

// Chat sessions functions
async function saveChatMessage(videoId, videoUuid, userId, message, response) {
  if (!isConnected) {
    return await saveChatMessageFallback(videoUuid, userId, message, response)
  }

  try {
    await dbClient.query(`
      INSERT INTO plugin_ai_chat_sessions
        (video_id, user_id, message, response)
      VALUES ($1, $2, $3, $4)
    `, [videoId, userId, message, response])
  } catch (error) {
    logger.error('Error saving chat message:', error)
  }
}

async function getChatHistory(videoId, userId = null) {
  if (!isConnected) {
    return await getChatHistoryFallback(videoId, userId)
  }

  try {
    let query = `
      SELECT message, response, created_at
      FROM plugin_ai_chat_sessions
      WHERE video_id = $1
    `
    const params = [videoId]

    if (userId) {
      query += ` AND user_id = $2`
      params.push(userId)
    }

    query += ` ORDER BY created_at DESC LIMIT 50`

    const result = await dbClient.query(query, params)
    return result.rows
  } catch (error) {
    logger.error('Error getting chat history:', error)
    return []
  }
}

// Processing queue functions
async function addToProcessingQueue(videoUuid, videoId) {
  if (!isConnected) {
    return await addToProcessingQueueFallback(videoUuid, videoId)
  }

  try {
    await dbClient.query(`
      INSERT INTO plugin_ai_processing_queue
        (video_id, video_uuid, status)
      VALUES ($1, $2, 'pending')
      ON CONFLICT (video_uuid) DO NOTHING
    `, [videoId, videoUuid])
  } catch (error) {
    logger.error('Error adding to queue:', error)
  }
}

async function updateProcessingStatus(videoUuid, status, errorMessage = null) {
  if (!isConnected) {
    return await updateProcessingStatusFallback(videoUuid, status, errorMessage)
  }

  try {
    await dbClient.query(`
      UPDATE plugin_ai_processing_queue
      SET status = $2::varchar,
          error_message = $3::text,
          processed_at = CASE WHEN $2::varchar = 'completed' THEN NOW() ELSE NULL END
      WHERE video_uuid = $1
    `, [videoUuid, status, errorMessage])
  } catch (error) {
    logger.error('Error updating processing status:', error)
  }
}

async function getProcessingStatus(videoUuid) {
  if (!isConnected) {
    return await getProcessingStatusFallback(videoUuid)
  }

  try {
    const result = await dbClient.query(`
      SELECT status, error_message, created_at, processed_at
      FROM plugin_ai_processing_queue
      WHERE video_uuid = $1
    `, [videoUuid])

    if (result.rows.length > 0) {
      const row = result.rows[0]
      return {
        status: row.status,
        errorMessage: row.error_message,
        createdAt: row.created_at,
        processedAt: row.processed_at,
        processing: row.status === 'processing',
        processed: row.status === 'completed'
      }
    }

    return { processed: false, processing: false }
  } catch (error) {
    logger.error('Error getting processing status:', error)
    return { processed: false, processing: false }
  }
}

// API usage tracking
async function trackAPIUsage(userId, endpoint, tokensUsed, cost = 0) {
  if (!isConnected) {
    return await trackAPIUsageFallback(userId, endpoint, tokensUsed, cost)
  }

  try {
    await dbClient.query(`
      INSERT INTO plugin_ai_api_usage
        (user_id, endpoint, tokens_used, cost)
      VALUES ($1, $2, $3, $4)
    `, [userId, endpoint, tokensUsed, cost])
  } catch (error) {
    logger.error('Error tracking API usage:', error)
  }
}

// Cleanup functions
async function cleanupVideoData(videoUuid) {
  logger.info(`Cleaning up data for video ${videoUuid}`)

  if (!isConnected) {
    return await cleanupVideoDataFallback(videoUuid)
  }

  try {
    await dbClient.query('DELETE FROM plugin_ai_video_embeddings WHERE video_uuid = $1', [videoUuid])
    await dbClient.query('DELETE FROM plugin_ai_video_snapshots WHERE video_uuid = $1', [videoUuid])
    await dbClient.query('DELETE FROM plugin_ai_processing_queue WHERE video_uuid = $1', [videoUuid])
    logger.info(`Cleanup completed for video ${videoUuid}`)
  } catch (error) {
    logger.error('Error cleaning up video data:', error)
  }
}

// Fallback functions using storageManager
async function saveVideoEmbeddingFallback(videoUuid, chunkIndex, data) {
  const embeddings = await storageManager.getData('video_embeddings') || {}
  if (!embeddings[videoUuid]) {
    embeddings[videoUuid] = { chunks: [] }
  }

  const existingIndex = embeddings[videoUuid].chunks.findIndex(c => c.chunkIndex === chunkIndex)
  if (existingIndex >= 0) {
    embeddings[videoUuid].chunks[existingIndex] = { chunkIndex, ...data }
  } else {
    embeddings[videoUuid].chunks.push({ chunkIndex, ...data })
  }

  await storageManager.storeData('video_embeddings', embeddings)
}

async function getVideoEmbeddingsFallback(videoUuid) {
  const embeddings = await storageManager.getData('video_embeddings') || {}
  return embeddings[videoUuid]?.chunks || []
}

async function findSimilarChunksFallback(videoUuid, queryEmbedding, limit = 5) {
  const chunks = await getVideoEmbeddingsFallback(videoUuid)

  if (!chunks || chunks.length === 0) {
    return []
  }

  const similarities = chunks.map(chunk => {
    const similarity = cosineSimilarity(queryEmbedding, chunk.embedding)
    return { ...chunk, similarity }
  })

  similarities.sort((a, b) => b.similarity - a.similarity)
  return similarities.slice(0, limit)
}

async function saveVideoSnapshotFallback(videoUuid, timestamp, filePath, description) {
  const snapshots = await storageManager.getData('video_snapshots') || {}
  if (!snapshots[videoUuid]) {
    snapshots[videoUuid] = { snapshots: [] }
  }

  const existing = snapshots[videoUuid].snapshots.find(s => s.timestamp === timestamp)
  if (!existing) {
    snapshots[videoUuid].snapshots.push({ timestamp, filePath, description })
    snapshots[videoUuid].snapshots.sort((a, b) => a.timestamp - b.timestamp)
    await storageManager.storeData('video_snapshots', snapshots)
  }
}

async function getVideoSnapshotsFallback(videoUuid) {
  const snapshots = await storageManager.getData('video_snapshots') || {}
  return snapshots[videoUuid]?.snapshots || []
}

async function saveChatMessageFallback(videoUuid, userId, message, response) {
  const sessions = await storageManager.getData('chat_sessions') || {}
  if (!sessions[videoUuid]) {
    sessions[videoUuid] = { sessions: [] }
  }

  sessions[videoUuid].sessions.push({
    userId, message, response,
    createdAt: new Date().toISOString()
  })

  if (sessions[videoUuid].sessions.length > 100) {
    sessions[videoUuid].sessions = sessions[videoUuid].sessions.slice(-100)
  }

  await storageManager.storeData('chat_sessions', sessions)
}

async function getChatHistoryFallback(videoId, userId = null) {
  const sessions = await storageManager.getData('chat_sessions') || {}
  const videoSessions = sessions[videoId]?.sessions || []

  if (userId) {
    return videoSessions.filter(s => s.userId === userId)
  }
  return videoSessions
}

async function addToProcessingQueueFallback(videoUuid, videoId) {
  const queueData = await storageManager.getData('processing_queue') || {}
  if (!queueData.queue) {
    queueData.queue = []
  }

  const existing = queueData.queue.find(item => item.videoUuid === videoUuid)
  if (!existing) {
    queueData.queue.push({
      videoUuid, videoId,
      status: 'pending',
      createdAt: new Date().toISOString()
    })
    await storageManager.storeData('processing_queue', queueData)
  }
}

async function updateProcessingStatusFallback(videoUuid, status, errorMessage = null) {
  const queueData = await storageManager.getData('processing_queue') || {}
  if (!queueData.queue) {
    queueData.queue = []
  }

  const item = queueData.queue.find(i => i.videoUuid === videoUuid)
  if (item) {
    item.status = status
    item.processedAt = status === 'completed' ? new Date().toISOString() : null
    item.errorMessage = errorMessage
    await storageManager.storeData('processing_queue', queueData)
  }
}

async function getProcessingStatusFallback(videoUuid) {
  const queueData = await storageManager.getData('processing_queue') || {}
  const item = queueData.queue?.find(i => i.videoUuid === videoUuid)

  if (item) {
    return {
      status: item.status,
      processing: item.status === 'processing',
      processed: item.status === 'completed'
    }
  }

  return { processed: false, processing: false }
}

async function trackAPIUsageFallback(userId, endpoint, tokensUsed, cost) {
  const usageData = await storageManager.getData('api_usage') || {}
  if (!usageData.usage) {
    usageData.usage = []
  }

  usageData.usage.push({
    userId, endpoint, tokensUsed, cost,
    createdAt: new Date().toISOString()
  })

  if (usageData.usage.length > 1000) {
    usageData.usage = usageData.usage.slice(-1000)
  }

  await storageManager.storeData('api_usage', usageData)
}

async function cleanupVideoDataFallback(videoUuid) {
  const embeddings = await storageManager.getData('video_embeddings') || {}
  if (embeddings[videoUuid]) {
    delete embeddings[videoUuid]
    await storageManager.storeData('video_embeddings', embeddings)
  }

  const snapshots = await storageManager.getData('video_snapshots') || {}
  if (snapshots[videoUuid]) {
    delete snapshots[videoUuid]
    await storageManager.storeData('video_snapshots', snapshots)
  }

  const sessions = await storageManager.getData('chat_sessions') || {}
  if (sessions[videoUuid]) {
    delete sessions[videoUuid]
    await storageManager.storeData('chat_sessions', sessions)
  }

  const queueData = await storageManager.getData('processing_queue') || {}
  if (queueData.queue) {
    queueData.queue = queueData.queue.filter(item => item.videoUuid !== videoUuid)
    await storageManager.storeData('processing_queue', queueData)
  }
}

// Helper function for cosine similarity
function cosineSimilarity(vecA, vecB) {
  if (!vecA || !vecB || vecA.length !== vecB.length) {
    return 0
  }

  let dotProduct = 0
  let normA = 0
  let normB = 0

  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i]
    normA += vecA[i] * vecA[i]
    normB += vecB[i] * vecB[i]
  }

  if (normA === 0 || normB === 0) {
    return 0
  }

  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB))
}

// Cleanup on disconnect
async function disconnect() {
  if (dbClient) {
    await dbClient.end()
    isConnected = false
    logger.info('Disconnected from database')
  }
}

module.exports = {
  initialize,
  disconnect,
  saveVideoEmbedding,
  getVideoEmbeddings,
  findSimilarChunks,
  saveVideoSnapshot,
  getVideoSnapshots,
  saveChatMessage,
  getChatHistory,
  addToProcessingQueue,
  updateProcessingStatus,
  getProcessingStatus,
  trackAPIUsage,
  cleanupVideoData,
  isConnected: () => isConnected
}