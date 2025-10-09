let logger = null
let peertubeHelpers = null

async function initialize(services) {
  logger = services.logger
  peertubeHelpers = services.peertubeHelpers

  try {
    const sequelize = peertubeHelpers.database.sequelize

    logger.info('Starting database initialization for AI Chat plugin...')

    // Create tables with pgvector support
    await sequelize.query(`
      CREATE EXTENSION IF NOT EXISTS vector;
    `).catch(err => {
      logger.warn('pgvector extension may already exist or require admin privileges:', err.message)
    })

    // Video embeddings table
    await sequelize.query(`
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
      );
    `)

    // Video snapshots table
    await sequelize.query(`
      CREATE TABLE IF NOT EXISTS plugin_ai_video_snapshots (
        id SERIAL PRIMARY KEY,
        video_id INTEGER NOT NULL,
        video_uuid VARCHAR(255) NOT NULL,
        timestamp FLOAT NOT NULL,
        file_path TEXT NOT NULL,
        description TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(video_uuid, timestamp)
      );
    `)

    // Chat sessions table
    await sequelize.query(`
      CREATE TABLE IF NOT EXISTS plugin_ai_chat_sessions (
        id SERIAL PRIMARY KEY,
        video_id INTEGER NOT NULL,
        user_id INTEGER,
        message TEXT NOT NULL,
        response TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `)

    // Processing queue table
    await sequelize.query(`
      CREATE TABLE IF NOT EXISTS plugin_ai_processing_queue (
        id SERIAL PRIMARY KEY,
        video_id INTEGER NOT NULL,
        video_uuid VARCHAR(255) NOT NULL,
        status VARCHAR(50) DEFAULT 'pending',
        error_message TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        processed_at TIMESTAMP,
        UNIQUE(video_uuid)
      );
    `)

    // API usage table
    await sequelize.query(`
      CREATE TABLE IF NOT EXISTS plugin_ai_api_usage (
        id SERIAL PRIMARY KEY,
        user_id INTEGER,
        endpoint VARCHAR(255),
        tokens_used INTEGER,
        cost DECIMAL(10, 6),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `)

    // Create indexes for better performance
    await sequelize.query(`
      CREATE INDEX IF NOT EXISTS idx_embeddings_video ON plugin_ai_video_embeddings(video_uuid);
      CREATE INDEX IF NOT EXISTS idx_snapshots_video ON plugin_ai_video_snapshots(video_uuid);
      CREATE INDEX IF NOT EXISTS idx_sessions_video ON plugin_ai_chat_sessions(video_id);
      CREATE INDEX IF NOT EXISTS idx_queue_status ON plugin_ai_processing_queue(status);
    `)

    logger.info('Database tables initialized successfully')

    // Verify tables were created
    const tables = await sequelize.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
      AND table_name LIKE 'plugin_ai_%'
    `, { type: sequelize.QueryTypes.SELECT })

    logger.info('Created AI Chat tables:', tables.map(t => t.table_name).join(', '))
  } catch (error) {
    logger.error('Failed to initialize database:', error)
    throw error // Re-throw to make sure the error is noticed
  }
}

module.exports = {
  initialize
}