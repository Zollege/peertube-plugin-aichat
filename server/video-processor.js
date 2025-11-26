const ffmpeg = require('fluent-ffmpeg')
const fs = require('fs').promises
const path = require('path')
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

  // Log available helpers for debugging
  if (peertubeHelpers) {
    logger.info('Available PeerTube helpers:')
    logger.info(`- videos: ${Object.keys(peertubeHelpers.videos || {}).join(', ')}`)
    logger.info(`- database: ${!!peertubeHelpers.database}`)
    logger.info(`- config: ${Object.keys(peertubeHelpers.config || {}).join(', ')}`)
    logger.info(`- plugin: ${Object.keys(peertubeHelpers.plugin || {}).join(', ')}`)
  }
}

// Check if video is ready for processing (transcoding complete)
function isVideoReady(video) {
  // PeerTube video states:
  // 1 = PUBLISHED (ready)
  // 2 = TO_TRANSCODE
  // 3 = TO_IMPORT
  // 4 = WAITING_FOR_LIVE
  // 5 = LIVE_ENDED
  // 6 = TO_MOVE_TO_EXTERNAL_STORAGE
  // 7 = TRANSCODING_FAILED
  // 8 = TO_EDIT
  const READY_STATE = 1
  const state = video.state?.id ?? video.state
  return state === READY_STATE
}

async function queueVideoForProcessing(video, retryCount = 0) {
  const MAX_RETRIES = 5
  const RETRY_DELAYS = [30000, 60000, 120000, 300000, 600000] // 30s, 1m, 2m, 5m, 10m

  try {
    // Load full video data to check state
    const fullVideo = await peertubeHelpers.videos.loadByIdOrUUID(video.uuid)

    if (!isVideoReady(fullVideo)) {
      if (retryCount < MAX_RETRIES) {
        const delay = RETRY_DELAYS[retryCount]
        const state = fullVideo.state?.id ?? fullVideo.state
        logger.info(`Video ${video.uuid} not ready (state: ${state}), retrying in ${delay / 1000}s (attempt ${retryCount + 1}/${MAX_RETRIES})`)

        // Schedule retry
        setTimeout(() => {
          queueVideoForProcessing(video, retryCount + 1)
        }, delay)

        // Update status to show waiting
        await databaseService.addToProcessingQueue(video.uuid, video.id)
        await databaseService.updateProcessingStatus(video.uuid, 'pending', `Waiting for transcoding (attempt ${retryCount + 1})`)
        return
      } else {
        logger.warn(`Video ${video.uuid} still not ready after ${MAX_RETRIES} retries, giving up`)
        await databaseService.updateProcessingStatus(video.uuid, 'error', 'Video transcoding did not complete in time')
        return
      }
    }

    // Video is ready, proceed with processing
    await databaseService.addToProcessingQueue(video.uuid, video.id)
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

    // Process transcript with retry logic
    // This will schedule retries if transcript isn't available yet (auto-generation in progress)
    await checkAndProcessTranscript(video)

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

  // Load video metadata (duration, etc.)
  let fullVideo = video
  try {
    const videoModel = await peertubeHelpers.videos.loadByIdOrUUID(video.uuid || video.id)
    if (videoModel) {
      fullVideo = videoModel.dataValues || videoModel
      logger.debug(`Loaded video metadata for ${video.uuid}`)
    }
  } catch (error) {
    logger.debug(`Could not load full video metadata: ${error.message}`)
  }

  const dataPath = peertubeHelpers.plugin.getDataDirectoryPath()
  const snapshotsDir = path.join(dataPath, 'snapshots', fullVideo.uuid)

  // Create directory
  await fs.mkdir(snapshotsDir, { recursive: true })

  // Get video file path with retry logic for files that might not be ready yet
  const MAX_FILE_RETRIES = 3
  const FILE_RETRY_DELAY = 10000 // 10 seconds
  let videoPath = null
  let fileRetries = 0

  while (!videoPath && fileRetries < MAX_FILE_RETRIES) {
    try {
      logger.info(`Attempting to get video URL for ${fullVideo.uuid} (attempt ${fileRetries + 1}/${MAX_FILE_RETRIES})`)

      // Use PeerTube's official getFiles() API to get video file URLs
      const filesData = await peertubeHelpers.videos.getFiles(fullVideo.id)

      // Prefer HLS files (streaming playlists)
      if (filesData?.hls?.videoFiles?.length > 0) {
        // Sort by resolution descending to get highest quality
        const sortedFiles = [...filesData.hls.videoFiles].sort((a, b) => b.resolution - a.resolution)
        const bestFile = sortedFiles[0]

        if (bestFile.url) {
          videoPath = bestFile.url
          logger.info(`Using HLS file URL: ${videoPath} (resolution: ${bestFile.resolution})`)
        }
      }
      // Fallback to web video files
      else if (filesData?.webVideo?.videoFiles?.length > 0) {
        const sortedFiles = [...filesData.webVideo.videoFiles].sort((a, b) => b.resolution - a.resolution)
        const bestFile = sortedFiles[0]

        if (bestFile.url) {
          videoPath = bestFile.url
          logger.info(`Using web video URL: ${videoPath} (resolution: ${bestFile.resolution})`)
        }
      }
    } catch (e) {
      logger.warn(`getFiles() failed: ${e.message}`)
    }

    // If no URL yet, wait and retry
    if (!videoPath) {
      fileRetries++
      if (fileRetries < MAX_FILE_RETRIES) {
        logger.info(`Files not available for ${fullVideo.uuid}, retrying in ${FILE_RETRY_DELAY / 1000}s (attempt ${fileRetries}/${MAX_FILE_RETRIES})`)
        await new Promise(resolve => setTimeout(resolve, FILE_RETRY_DELAY))
      }
    }
  }

  // If still no URL after retries, skip snapshot extraction
  if (!videoPath) {
    logger.error(`Failed to get video URL for ${fullVideo.uuid} after ${MAX_FILE_RETRIES} attempts - files unavailable`)
    return // Skip snapshot extraction but continue processing
  }

  logger.info(`Video URL ready for processing: ${videoPath}`)

  const duration = fullVideo.duration || video.duration
  const snapshots = []

  logger.info(`Processing video snapshots: URL=${videoPath}, Duration=${duration}s`)

  // Extract snapshots at intervals
  for (let timestamp = 0; timestamp < duration; timestamp += interval) {
    const outputPath = path.join(snapshotsDir, `snapshot-${timestamp}.jpg`)

    try {
      await new Promise((resolve, reject) => {
        const ffmpegCommand = ffmpeg(videoPath)
          .seekInput(timestamp)
          .frames(1)
          .output(outputPath)
          .outputOptions(['-q:v', '2'])

        // Add input options for remote URLs
        if (videoPath.startsWith('http://') || videoPath.startsWith('https://')) {
          // Add options for handling remote files
          ffmpegCommand.inputOptions([
            '-analyzeduration', '10000000', // Analyze duration for better seeking
            '-probesize', '10000000'         // Probe size for remote files
          ])

          // For HLS playlists, add protocol whitelist
          if (videoPath.includes('.m3u8')) {
            ffmpegCommand.inputOptions([
              '-protocol_whitelist', 'file,http,https,tcp,tls'
            ])
          }
        }

        ffmpegCommand
          .on('start', (cmd) => {
            logger.debug(`FFmpeg command: ${cmd}`)
          })
          .on('end', resolve)
          .on('error', (err) => {
            logger.error(`FFmpeg error at ${timestamp}s: ${err.message}`)
            reject(err)
          })
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
  try {
    let captionUrl = null
    let captionContent = null

    // Query captions directly from PeerTube's database (most reliable method)
    if (peertubeHelpers.database?.query) {
      try {
        const result = await peertubeHelpers.database.query(`
          SELECT vc."language", vc."filename", vc."fileUrl"
          FROM "videoCaption" vc
          JOIN video v ON vc."videoId" = v.id
          WHERE v.uuid = $1
        `, { bind: [video.uuid] })

        // Handle different result formats
        let captions = []
        if (Array.isArray(result)) {
          captions = Array.isArray(result[0]) ? result[0] : result
        } else if (result?.rows) {
          captions = result.rows
        }

        if (captions.length > 0) {
          // Prefer English
          const caption = captions.find(c => c.language === 'en') || captions[0]
          if (caption.fileUrl) {
            captionUrl = caption.fileUrl
            logger.info(`Found caption for video ${video.uuid}: ${caption.language}`)
          }
        }
      } catch (e) {
        logger.debug(`Caption database query failed: ${e.message}`)
      }
    }

    // If we have a remote caption URL, fetch it
    if (captionUrl && (captionUrl.startsWith('http://') || captionUrl.startsWith('https://'))) {
      try {
        const https = require('https')
        const http = require('http')

        captionContent = await new Promise((resolve, reject) => {
          const client = captionUrl.startsWith('https') ? https : http

          client.get(captionUrl, (res) => {
            if (res.statusCode === 200) {
              let data = ''
              res.on('data', chunk => data += chunk)
              res.on('end', () => resolve(data))
              res.on('error', reject)
            } else {
              logger.debug(`Caption URL returned status ${res.statusCode}`)
              resolve(null)
            }
          }).on('error', reject)
        })

        if (captionContent) {
          logger.info(`Downloaded caption for video ${video.uuid}`)
          return captionContent
        }
      } catch (error) {
        logger.debug('Error downloading remote caption:', error.message)
      }
    }

    // Fallback: Try local file paths
    const possiblePaths = [
      `/data/captions/${video.uuid}-en.vtt`,
      `/data/captions/${video.uuid}.vtt`,
      `/var/www/peertube/storage/captions/${video.uuid}-en.vtt`,
      `/var/www/peertube/storage/captions/${video.uuid}.vtt`,
      `/var/www/peertube/storage/captions/${video.uuid}-fr.vtt`,
      `/var/www/peertube/storage/captions/${video.uuid}-es.vtt`
    ]

    // If we have a local caption path from the API, add it to the list
    if (captionUrl && !captionUrl.startsWith('http')) {
      possiblePaths.unshift(captionUrl)
    }

    // Also check for any language code in local directories
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

    // Try to find and read VTT file locally
    for (const filePath of possiblePaths) {
      try {
        const content = await fs.readFile(filePath, 'utf-8')
        logger.info(`Found local caption file at: ${filePath}`)
        return content
      } catch {
        // File doesn't exist, try next
      }
    }

    logger.debug(`No caption found for video ${video.uuid}`)
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

async function checkAndProcessTranscript(video, retryCount = 0) {
  const MAX_TRANSCRIPT_RETRIES = 5
  const TRANSCRIPT_RETRY_DELAY = 60000 // 60 seconds

  // Check if transcript is now available and process if needed
  const embeddings = await databaseService.getVideoEmbeddings(video.uuid)

  if (!embeddings || embeddings.length === 0) {
    logger.info(`Checking for transcript for video ${video.uuid} (attempt ${retryCount + 1}/${MAX_TRANSCRIPT_RETRIES + 1})`)

    await processVideoTranscript(video)
    await generateVideoEmbeddings(video)

    // Check if we actually got any embeddings
    const newEmbeddings = await databaseService.getVideoEmbeddings(video.uuid)

    if ((!newEmbeddings || newEmbeddings.length === 0) && retryCount < MAX_TRANSCRIPT_RETRIES) {
      // No transcript found yet - schedule a retry
      // This handles the case where auto-generated captions aren't ready yet
      logger.info(`No transcript found for video ${video.uuid}, scheduling retry in ${TRANSCRIPT_RETRY_DELAY / 1000}s`)

      setTimeout(() => {
        checkAndProcessTranscript(video, retryCount + 1).catch(err => {
          logger.error(`Error in transcript retry for ${video.uuid}:`, err)
        })
      }, TRANSCRIPT_RETRY_DELAY)
    } else if (newEmbeddings && newEmbeddings.length > 0) {
      logger.info(`Successfully processed ${newEmbeddings.length} transcript chunks for video ${video.uuid}`)
    } else {
      logger.info(`No transcript available for video ${video.uuid} after ${retryCount + 1} attempts`)
    }
  } else {
    logger.debug(`Video ${video.uuid} already has ${embeddings.length} transcript embeddings`)
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
  getProcessingStatus,
  isVideoReady
}