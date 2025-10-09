const ffmpeg = require('fluent-ffmpeg')
const fs = require('fs').promises
const path = require('path')
const openaiService = require('./openai-service')

let logger = null
let settingsManager = null
let peertubeHelpers = null

function initialize(services) {
  logger = services.logger
  settingsManager = services.settingsManager
  peertubeHelpers = services.peertubeHelpers
}

async function queueVideoForProcessing(video) {
  try {
    const sequelize = peertubeHelpers.database.sequelize

    // Add to processing queue
    await sequelize.query(`
      INSERT INTO plugin_ai_processing_queue (video_id, video_uuid, status)
      VALUES ($1, $2, 'pending')
      ON CONFLICT (video_uuid) DO NOTHING;
    `, {
      bind: [video.id, video.uuid]
    })

    // Start processing in background
    processVideo(video).catch(err => {
      logger.error(`Error processing video ${video.uuid}:`, err)
    })

  } catch (error) {
    logger.error('Failed to queue video for processing:', error)
  }
}

async function processVideo(video) {
  const sequelize = peertubeHelpers.database.sequelize

  try {
    logger.info(`Starting processing for video ${video.uuid}`)

    // Update status to processing
    await sequelize.query(`
      UPDATE plugin_ai_processing_queue
      SET status = 'processing'
      WHERE video_uuid = $1;
    `, {
      bind: [video.uuid]
    })

    // Process snapshots
    await extractVideoSnapshots(video)

    // Process transcript
    await processVideoTranscript(video)

    // Generate embeddings
    await generateVideoEmbeddings(video)

    // Update status to completed
    await sequelize.query(`
      UPDATE plugin_ai_processing_queue
      SET status = 'completed', processed_at = CURRENT_TIMESTAMP
      WHERE video_uuid = $1;
    `, {
      bind: [video.uuid]
    })

    logger.info(`Successfully processed video ${video.uuid}`)
  } catch (error) {
    // Update status to error
    await sequelize.query(`
      UPDATE plugin_ai_processing_queue
      SET status = 'error', error_message = $2
      WHERE video_uuid = $1;
    `, {
      bind: [video.uuid, error.message]
    })

    logger.error(`Failed to process video ${video.uuid}:`, error)
    throw error
  }
}

async function extractVideoSnapshots(video) {
  // Get configured interval from settings, with validation
  let interval = parseInt(await settingsManager.getSetting('snapshot-interval') || '5')

  // Validate interval is within reasonable bounds
  if (isNaN(interval) || interval < 1) {
    interval = 5
    logger.warn(`Invalid snapshot interval, using default: 5 seconds`)
  } else if (interval > 60) {
    interval = 60
    logger.warn(`Snapshot interval too large, capping at maximum: 60 seconds`)
  }

  logger.info(`Using snapshot interval of ${interval} seconds for video ${video.uuid}`)

  const dataPath = peertubeHelpers.plugin.getDataDirectoryPath()
  const snapshotsDir = path.join(dataPath, 'snapshots', video.uuid)

  // Create directory
  await fs.mkdir(snapshotsDir, { recursive: true })

  // Get video file path
  let videoPath
  try {
    // Try to get the video file path - this might need adjustment based on PeerTube version
    const videoFiles = await peertubeHelpers.videos.getFiles(video.id)
    if (videoFiles && videoFiles.length > 0) {
      videoPath = videoFiles[0].path
    } else {
      throw new Error('No video files found')
    }
  } catch (error) {
    logger.error('Could not get video file path:', error)
    return
  }

  const duration = video.duration
  const snapshots = []
  const sequelize = peertubeHelpers.database.sequelize

  // Extract snapshots at intervals
  for (let timestamp = 0; timestamp < duration; timestamp += interval) {
    const outputPath = path.join(snapshotsDir, `snapshot-${timestamp}.jpg`)

    try {
      await new Promise((resolve, reject) => {
        ffmpeg(videoPath)
          .seekInput(timestamp)
          .frames(1)
          .output(outputPath)
          .outputOptions(['-q:v', '2'])
          .on('end', resolve)
          .on('error', reject)
          .run()
      })

      // Store snapshot reference in database
      await sequelize.query(`
        INSERT INTO plugin_ai_video_snapshots (video_id, video_uuid, timestamp, file_path)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (video_uuid, timestamp) DO UPDATE
        SET file_path = $4;
      `, {
        bind: [video.id, video.uuid, timestamp, outputPath]
      })

      snapshots.push({ timestamp, path: outputPath })
      logger.debug(`Extracted snapshot at ${timestamp}s for video ${video.uuid}`)
    } catch (error) {
      logger.error(`Failed to extract snapshot at ${timestamp}s:`, error)
    }
  }

  // Analyze snapshots with GPT-4 Vision if OpenAI is initialized
  if (openaiService.isInitialized() && snapshots.length > 0) {
    await analyzeSnapshots(video, snapshots)
  }

  logger.info(`Extracted ${snapshots.length} snapshots for video ${video.uuid}`)
}

async function analyzeSnapshots(video, snapshots) {
  const sequelize = peertubeHelpers.database.sequelize

  for (const snapshot of snapshots) {
    try {
      // Read image and convert to base64
      const imageBuffer = await fs.readFile(snapshot.path)
      const base64Image = imageBuffer.toString('base64')

      // Analyze with GPT-4 Vision
      const description = await openaiService.analyzeImage(base64Image)

      // Update snapshot with description
      await sequelize.query(`
        UPDATE plugin_ai_video_snapshots
        SET description = $3
        WHERE video_uuid = $1 AND timestamp = $2;
      `, {
        bind: [video.uuid, snapshot.timestamp, description]
      })

      logger.debug(`Analyzed snapshot at ${snapshot.timestamp}s`)
    } catch (error) {
      logger.error(`Failed to analyze snapshot at ${snapshot.timestamp}s:`, error)
    }
  }
}

async function processVideoTranscript(video) {
  const sequelize = peertubeHelpers.database.sequelize

  try {
    // Get video captions/transcripts
    // This needs to be adapted based on actual PeerTube API
    const transcriptData = await getVideoTranscript(video)

    if (!transcriptData) {
      logger.info(`No transcript available for video ${video.uuid}`)
      return
    }

    // Parse transcript into chunks
    const chunks = parseTranscript(transcriptData)

    // Store chunks in database
    for (const chunk of chunks) {
      await sequelize.query(`
        INSERT INTO plugin_ai_video_embeddings
        (video_id, video_uuid, chunk_index, start_time, end_time, content)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (video_uuid, chunk_index) DO UPDATE
        SET content = $6, start_time = $4, end_time = $5;
      `, {
        bind: [
          video.id,
          video.uuid,
          chunk.index,
          chunk.startTime,
          chunk.endTime,
          chunk.content
        ]
      })
    }

    logger.info(`Processed ${chunks.length} transcript chunks for video ${video.uuid}`)
  } catch (error) {
    logger.error(`Failed to process transcript for video ${video.uuid}:`, error)
  }
}

async function getVideoTranscript(video) {
  // This function needs to be implemented based on PeerTube's actual transcript API
  // For now, returning null as a placeholder
  try {
    // Check if video has captions
    const sequelize = peertubeHelpers.database.sequelize
    const [captions] = await sequelize.query(`
      SELECT * FROM "videoCaption"
      WHERE "videoId" = $1
      ORDER BY "language" ASC
      LIMIT 1;
    `, {
      bind: [video.id]
    })

    if (captions && captions.length > 0) {
      const captionPath = captions[0].fileUrl || captions[0].path
      if (captionPath) {
        const content = await fs.readFile(captionPath, 'utf-8')
        return content
      }
    }
  } catch (error) {
    logger.error('Error getting video transcript:', error)
  }

  return null
}

function parseTranscript(transcriptText) {
  const chunks = []
  const chunkDuration = 30 // 30 seconds per chunk
  let currentChunk = { index: 0, startTime: 0, endTime: 0, content: '' }

  // Simple VTT/SRT parser
  const lines = transcriptText.split('\n')
  let currentTime = 0

  for (const line of lines) {
    // Parse timestamp lines
    if (line.includes('-->')) {
      const times = line.split('-->')
      if (times.length === 2) {
        currentTime = parseTimestamp(times[0].trim())
      }
    } else if (line.trim() && !line.match(/^\d+$/) && !line.startsWith('WEBVTT')) {
      // Text content (skip numbers and WEBVTT header)
      currentChunk.content += ' ' + line.trim()

      // Check if we should start a new chunk
      if (currentTime - currentChunk.startTime >= chunkDuration) {
        currentChunk.endTime = currentTime
        if (currentChunk.content.trim()) {
          chunks.push({ ...currentChunk })
        }

        currentChunk = {
          index: chunks.length,
          startTime: currentTime,
          endTime: 0,
          content: ''
        }
      }
    }
  }

  // Add the last chunk
  if (currentChunk.content.trim()) {
    currentChunk.endTime = currentTime || currentChunk.startTime + chunkDuration
    chunks.push(currentChunk)
  }

  return chunks
}

function parseTimestamp(timestamp) {
  // Parse "00:00:00.000" or "00:00.000" format to seconds
  const parts = timestamp.split(':')
  if (parts.length === 3) {
    return parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2])
  } else if (parts.length === 2) {
    return parseFloat(parts[0]) * 60 + parseFloat(parts[1])
  }
  return 0
}

async function generateVideoEmbeddings(video) {
  if (!openaiService.isInitialized()) {
    logger.warn('OpenAI client not initialized, skipping embeddings generation')
    return
  }

  const sequelize = peertubeHelpers.database.sequelize

  // Get all text chunks that need embeddings
  const [chunks] = await sequelize.query(`
    SELECT id, chunk_index, content, start_time, end_time
    FROM plugin_ai_video_embeddings
    WHERE video_uuid = $1 AND embedding IS NULL
    ORDER BY chunk_index;
  `, {
    bind: [video.uuid]
  })

  for (const chunk of chunks) {
    try {
      // Generate embedding
      const embedding = await openaiService.generateEmbedding(chunk.content)

      // Store embedding
      await sequelize.query(`
        UPDATE plugin_ai_video_embeddings
        SET embedding = $2::vector
        WHERE id = $1;
      `, {
        bind: [chunk.id, `[${embedding.join(',')}]`]
      })

      logger.debug(`Generated embedding for chunk ${chunk.chunk_index}`)
    } catch (error) {
      logger.error(`Failed to generate embedding for chunk ${chunk.id}:`, error)
    }
  }

  logger.info(`Generated embeddings for video ${video.uuid}`)
}

async function checkAndProcessTranscript(video) {
  // Check if transcript is now available and process if needed
  const sequelize = peertubeHelpers.database.sequelize

  const [[result]] = await sequelize.query(`
    SELECT COUNT(*) as count
    FROM plugin_ai_video_embeddings
    WHERE video_uuid = $1;
  `, {
    bind: [video.uuid]
  })

  if (parseInt(result.count) === 0) {
    await processVideoTranscript(video)
    await generateVideoEmbeddings(video)
  }
}

async function cleanupVideoData(video) {
  const sequelize = peertubeHelpers.database.sequelize
  const dataPath = peertubeHelpers.plugin.getDataDirectoryPath()
  const snapshotsDir = path.join(dataPath, 'snapshots', video.uuid)

  try {
    // Delete from database
    await sequelize.query(`
      DELETE FROM plugin_ai_video_embeddings WHERE video_uuid = $1;
      DELETE FROM plugin_ai_video_snapshots WHERE video_uuid = $1;
      DELETE FROM plugin_ai_chat_sessions WHERE video_id = $2;
      DELETE FROM plugin_ai_processing_queue WHERE video_uuid = $1;
    `, {
      bind: [video.uuid, video.id]
    })

    // Delete snapshot files
    await fs.rm(snapshotsDir, { recursive: true, force: true })

    logger.info(`Cleaned up data for video ${video.uuid}`)
  } catch (error) {
    logger.error(`Failed to cleanup video data:`, error)
  }
}

async function getProcessingStatus(videoUuid) {
  const sequelize = peertubeHelpers.database.sequelize

  const [[status]] = await sequelize.query(`
    SELECT status, error_message, processed_at
    FROM plugin_ai_processing_queue
    WHERE video_uuid = $1;
  `, {
    bind: [videoUuid]
  })

  return status || { status: 'not_processed' }
}

module.exports = {
  initialize,
  queueVideoForProcessing,
  processVideo,
  checkAndProcessTranscript,
  cleanupVideoData,
  getProcessingStatus
}