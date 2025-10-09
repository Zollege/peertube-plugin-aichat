const ffmpeg = require('fluent-ffmpeg')
const fs = require('fs').promises
const path = require('path')
const openaiService = require('./openai-service')
const databaseService = require('./database-service')

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
    // Add to processing queue using database service
    await databaseService.addToProcessingQueue(video.uuid, video.id)

    // Start processing in background
    processVideo(video).catch(err => {
      logger.error(`Error processing video ${video.uuid}:`, err)
    })

  } catch (error) {
    logger.error('Failed to queue video for processing:', error)
  }
}

async function processVideo(video) {
  try {
    logger.info(`Starting processing for video ${video.uuid}`)

    // Update status to processing
    await databaseService.updateProcessingStatus(video.uuid, 'processing')

    // Process snapshots
    await extractVideoSnapshots(video)

    // Process transcript
    await processVideoTranscript(video)

    // Generate embeddings
    await generateVideoEmbeddings(video)

    // Update status to completed
    await databaseService.updateProcessingStatus(video.uuid, 'completed')

    logger.info(`Successfully processed video ${video.uuid}`)
  } catch (error) {
    // Update status to error
    await databaseService.updateProcessingStatus(video.uuid, 'error', error.message)

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
    // Try multiple approaches to find the video file

    // Approach 1: Try PeerTube helpers if available
    try {
      const videoFiles = await peertubeHelpers.videos.getFiles(video.id)
      if (videoFiles && videoFiles.length > 0) {
        videoPath = videoFiles[0].path
        logger.info(`Found video file via helpers: ${videoPath}`)
      }
    } catch (e) {
      logger.debug('Could not get files via helpers:', e.message)
    }

    // Approach 2: Check standard PeerTube storage locations
    if (!videoPath) {
      const possiblePaths = [
        `/data/videos/${video.uuid}-720.mp4`,
        `/data/videos/${video.uuid}-480.mp4`,
        `/data/videos/${video.uuid}-360.mp4`,
        `/data/videos/${video.uuid}-240.mp4`,
        `/data/videos/${video.uuid}-1080.mp4`,
        `/var/www/peertube/storage/videos/${video.uuid}-720.mp4`,
        `/var/www/peertube/storage/videos/${video.uuid}-480.mp4`,
        `/var/www/peertube/storage/streaming-playlists/hls/${video.uuid}/${video.uuid}-720-fragmented.mp4`,
        `/var/www/peertube/storage/streaming-playlists/hls/${video.uuid}/${video.uuid}-480-fragmented.mp4`
      ]

      for (const testPath of possiblePaths) {
        try {
          await fs.access(testPath)
          videoPath = testPath
          logger.info(`Found video file at: ${videoPath}`)
          break
        } catch {
          // File doesn't exist at this path, try next
        }
      }
    }

    // Approach 3: Check if video has streamingPlaylists
    if (!videoPath && video.streamingPlaylists && video.streamingPlaylists.length > 0) {
      const playlist = video.streamingPlaylists[0]
      if (playlist.files && playlist.files.length > 0) {
        // Use the first available file
        const file = playlist.files[0]
        videoPath = file.fileUrl || file.torrentUrl
        logger.info(`Using streaming playlist file: ${videoPath}`)
      }
    }

    if (!videoPath) {
      logger.warn(`No local video file found for ${video.uuid}, skipping snapshot extraction`)
      return // Skip snapshot extraction but continue processing
    }
  } catch (error) {
    logger.error('Error while searching for video file:', error)
    return // Skip snapshot extraction but continue processing
  }

  const duration = video.duration
  const snapshots = []

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
      await databaseService.saveVideoSnapshot(video.uuid, video.id, timestamp, outputPath, null)

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
  for (const snapshot of snapshots) {
    try {
      // Read image and convert to base64
      const imageBuffer = await fs.readFile(snapshot.path)
      const base64Image = imageBuffer.toString('base64')

      // Analyze with GPT-4 Vision
      const description = await openaiService.analyzeImage(base64Image)

      // Update snapshot with description
      await databaseService.saveVideoSnapshot(video.uuid, video.id, snapshot.timestamp, snapshot.path, description)

      logger.debug(`Analyzed snapshot at ${snapshot.timestamp}s`)
    } catch (error) {
      logger.error(`Failed to analyze snapshot at ${snapshot.timestamp}s:`, error)
    }
  }
}

async function processVideoTranscript(video) {
  try {
    // Get video captions/transcripts
    const transcriptData = await getVideoTranscript(video)

    if (!transcriptData) {
      logger.info(`No transcript available for video ${video.uuid}`)
      return
    }

    // Parse transcript into chunks
    const chunks = parseTranscript(transcriptData)

    // Store chunks in database
    for (const chunk of chunks) {
      await databaseService.saveVideoEmbedding(video.uuid, video.id, chunk.index, {
        startTime: chunk.startTime,
        endTime: chunk.endTime,
        content: chunk.content,
        embedding: null // Will be generated later
      })
    }

    logger.info(`Processed ${chunks.length} transcript chunks for video ${video.uuid}`)
  } catch (error) {
    logger.error(`Failed to process transcript for video ${video.uuid}:`, error)
  }
}

async function getVideoTranscript(video) {
  // This function needs to be implemented based on PeerTube's actual transcript API
  try {
    // Try multiple locations for caption files
    const possiblePaths = [
      `/data/captions/${video.uuid}-en.vtt`,
      `/data/captions/${video.uuid}.vtt`,
      `/var/www/peertube/storage/captions/${video.uuid}-en.vtt`,
      `/var/www/peertube/storage/captions/${video.uuid}.vtt`,
      `/var/www/peertube/storage/captions/${video.uuid}-fr.vtt`,
      `/var/www/peertube/storage/captions/${video.uuid}-es.vtt`
    ]

    // Also check for any language code
    const captionDirs = ['/data/captions', '/var/www/peertube/storage/captions']
    for (const dir of captionDirs) {
      try {
        const files = await fs.readdir(dir)
        const videoCaption = files.find(f => f.startsWith(video.uuid) && f.endsWith('.vtt'))
        if (videoCaption) {
          possiblePaths.push(path.join(dir, videoCaption))
        }
      } catch {
        // Directory doesn't exist or can't be read
      }
    }

    // Try to find and read VTT file
    for (const filePath of possiblePaths) {
      try {
        const content = await fs.readFile(filePath, 'utf-8')
        logger.info(`Found caption file at: ${filePath}`)
        return content
      } catch {
        // File doesn't exist, try next
      }
    }

    logger.info(`No caption files found for video ${video.uuid}`)
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

  // Get all text chunks that need embeddings
  const chunks = await databaseService.getVideoEmbeddings(video.uuid)

  for (const chunk of chunks) {
    try {
      // Skip if embedding already exists
      if (chunk.embedding && chunk.embedding.length > 0) {
        continue
      }

      // Generate embedding
      const embedding = await openaiService.generateEmbedding(chunk.content)

      // Store embedding
      await databaseService.saveVideoEmbedding(video.uuid, video.id, chunk.chunkIndex, {
        startTime: chunk.startTime,
        endTime: chunk.endTime,
        content: chunk.content,
        embedding: embedding
      })

      logger.debug(`Generated embedding for chunk ${chunk.chunkIndex}`)
    } catch (error) {
      logger.error(`Failed to generate embedding for chunk ${chunk.chunkIndex}:`, error)
    }
  }

  logger.info(`Generated embeddings for video ${video.uuid}`)
}

async function checkAndProcessTranscript(video) {
  // Check if transcript is now available and process if needed
  const embeddings = await databaseService.getVideoEmbeddings(video.uuid)

  if (!embeddings || embeddings.length === 0) {
    await processVideoTranscript(video)
    await generateVideoEmbeddings(video)
  }
}

async function cleanupVideoData(video) {
  const dataPath = peertubeHelpers.plugin.getDataDirectoryPath()
  const snapshotsDir = path.join(dataPath, 'snapshots', video.uuid)

  try {
    // Delete from database
    await databaseService.cleanupVideoData(video.uuid)

    // Delete snapshot files
    await fs.rm(snapshotsDir, { recursive: true, force: true })

    logger.info(`Cleaned up data for video ${video.uuid}`)
  } catch (error) {
    logger.error(`Failed to cleanup video data:`, error)
  }
}

async function getProcessingStatus(videoUuid) {
  return await databaseService.getProcessingStatus(videoUuid)
}

module.exports = {
  initialize,
  queueVideoForProcessing,
  processVideo,
  checkAndProcessTranscript,
  cleanupVideoData,
  getProcessingStatus
}