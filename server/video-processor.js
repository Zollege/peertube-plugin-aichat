const ffmpeg = require('fluent-ffmpeg')
const fs = require('fs').promises
const path = require('path')
const openaiService = require('./openai-service')
const databaseService = require('./database-service')
const spacesService = require('./spaces-service')

let logger = null
let settingsManager = null
let peertubeHelpers = null

function initialize(services) {
  logger = services.logger
  settingsManager = services.settingsManager
  peertubeHelpers = services.peertubeHelpers

  // Initialize spaces service
  spacesService.initialize(services)

  // Log available helpers for debugging
  if (peertubeHelpers) {
    logger.info('Available PeerTube helpers:')
    logger.info(`- videos: ${Object.keys(peertubeHelpers.videos || {}).join(', ')}`)
    logger.info(`- database: ${!!peertubeHelpers.database}`)
    logger.info(`- config: ${Object.keys(peertubeHelpers.config || {}).join(', ')}`)
    logger.info(`- plugin: ${Object.keys(peertubeHelpers.plugin || {}).join(', ')}`)
  }
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

  // IMPORTANT: First, try to load the complete video object
  // The video object passed to hooks might be minimal
  let fullVideo = video

  // Log video privacy level for debugging, but we'll handle all videos the same way
  if (video.privacy) {
    logger.info(`Video privacy level: ${video.privacy}`)
  }
  try {
    logger.info(`Loading full video details for ${video.uuid}`)

    // Try different loading methods to get the full video with files
    let videoModel = null

    // Method 1: Try loadByIdOrUUID
    videoModel = await peertubeHelpers.videos.loadByIdOrUUID(video.uuid || video.id)

    if (videoModel) {
      logger.info(`Loaded video model with keys: ${Object.keys(videoModel).join(', ')}`)

      // Extract the actual video data from the Sequelize model
      if (videoModel.dataValues) {
        fullVideo = videoModel.dataValues
        logger.info(`Video data keys: ${Object.keys(fullVideo).join(', ')}`)
      }

      // Check for VideoFiles (Sequelize association)
      if (videoModel.VideoFiles) {
        logger.info(`VideoFiles exists with ${videoModel.VideoFiles.length} files`)
        if (videoModel.VideoFiles.length > 0) {
          const firstFile = videoModel.VideoFiles[0]
          if (firstFile.dataValues) {
            logger.info(`First VideoFile data: ${JSON.stringify(firstFile.dataValues)}`)
          } else {
            logger.info(`First VideoFile keys: ${Object.keys(firstFile).join(', ')}`)
          }
        }
        // Add VideoFiles to fullVideo for easier access
        fullVideo.VideoFiles = videoModel.VideoFiles
      } else {
        logger.info('VideoFiles not loaded with model, will try to fetch separately')
      }

      // Check for VideoStreamingPlaylists (Sequelize association)
      if (videoModel.VideoStreamingPlaylists) {
        logger.info(`VideoStreamingPlaylists exists with ${videoModel.VideoStreamingPlaylists.length} playlists`)
        if (videoModel.VideoStreamingPlaylists.length > 0) {
          const firstPlaylist = videoModel.VideoStreamingPlaylists[0]
          if (firstPlaylist.dataValues) {
            logger.info(`First playlist data: ${JSON.stringify(firstPlaylist.dataValues)}`)
          }
          // Check if playlist has VideoFiles
          if (firstPlaylist.VideoFiles) {
            logger.info(`Playlist has ${firstPlaylist.VideoFiles.length} VideoFiles`)
            if (firstPlaylist.VideoFiles.length > 0) {
              const firstFile = firstPlaylist.VideoFiles[0]
              if (firstFile.dataValues) {
                logger.info(`First playlist file data: ${JSON.stringify(firstFile.dataValues)}`)
              }
            }
          }
        }
        // Add to fullVideo for easier access
        fullVideo.VideoStreamingPlaylists = videoModel.VideoStreamingPlaylists
      } else {
        logger.info('VideoStreamingPlaylists not loaded with model')
      }

      // If no files were loaded, try to get them through the API
      if ((!videoModel.VideoFiles || videoModel.VideoFiles.length === 0) &&
          (!videoModel.VideoStreamingPlaylists || videoModel.VideoStreamingPlaylists.length === 0)) {
        logger.info('No files loaded with model, attempting to fetch video with full details')

        // Try to get video details through other means
        try {
          // Method 2: Try to get video by UUID with a fresh load
          const videoId = fullVideo.id || video.id
          if (videoId) {
            logger.info(`Attempting to reload video by ID: ${videoId}`)
            const reloadedVideo = await peertubeHelpers.videos.loadByIdOrUUID(videoId)
            if (reloadedVideo) {
              logger.info(`Reloaded video has files: VideoFiles=${!!reloadedVideo.VideoFiles}, StreamingPlaylists=${!!reloadedVideo.VideoStreamingPlaylists}`)

              // CRITICAL: Actually assign the files to fullVideo so they can be checked later
              if (reloadedVideo.VideoFiles) {
                fullVideo.VideoFiles = reloadedVideo.VideoFiles
                videoModel.VideoFiles = reloadedVideo.VideoFiles
                logger.info(`Assigned ${reloadedVideo.VideoFiles.length} VideoFiles to fullVideo`)

                // Log the actual file data
                if (reloadedVideo.VideoFiles.length > 0) {
                  const firstFile = reloadedVideo.VideoFiles[0]
                  const fileData = firstFile.dataValues || firstFile
                  logger.info(`First VideoFile data: ${JSON.stringify(fileData)}`)
                }
              }

              if (reloadedVideo.VideoStreamingPlaylists) {
                fullVideo.VideoStreamingPlaylists = reloadedVideo.VideoStreamingPlaylists
                videoModel.VideoStreamingPlaylists = reloadedVideo.VideoStreamingPlaylists
                logger.info(`Assigned ${reloadedVideo.VideoStreamingPlaylists.length} StreamingPlaylists to fullVideo`)

                // Log the actual playlist data
                if (reloadedVideo.VideoStreamingPlaylists.length > 0) {
                  const firstPlaylist = reloadedVideo.VideoStreamingPlaylists[0]
                  const playlistData = firstPlaylist.dataValues || firstPlaylist
                  logger.info(`First Playlist data: ${JSON.stringify(playlistData)}`)

                  // Check for nested VideoFiles in playlists
                  if (firstPlaylist.VideoFiles && firstPlaylist.VideoFiles.length > 0) {
                    logger.info(`Playlist has ${firstPlaylist.VideoFiles.length} nested VideoFiles`)
                    const firstNestedFile = firstPlaylist.VideoFiles[0]
                    const nestedFileData = firstNestedFile.dataValues || firstNestedFile
                    logger.info(`First nested VideoFile data: ${JSON.stringify(nestedFileData)}`)
                  }
                }
              }

              // Log what we have after assignment
              logger.info(`After reload - fullVideo.VideoFiles: ${fullVideo.VideoFiles ? fullVideo.VideoFiles.length : 0} files`)
              logger.info(`After reload - fullVideo.VideoStreamingPlaylists: ${fullVideo.VideoStreamingPlaylists ? fullVideo.VideoStreamingPlaylists.length : 0} playlists`)
            }
          }
        } catch (e) {
          logger.debug('Could not reload video:', e.message)
        }
      }
    } else {
      logger.warn(`Could not load full video details, using original video object`)
      fullVideo = video
    }
  } catch (error) {
    logger.error(`Error loading full video:`, error)
    fullVideo = video
  }

  const dataPath = peertubeHelpers.plugin.getDataDirectoryPath()
  const snapshotsDir = path.join(dataPath, 'snapshots', fullVideo.uuid)

  // Create directory
  await fs.mkdir(snapshotsDir, { recursive: true })

  // Get video file path - we'll construct it directly from the UUID
  let videoPath
  try {
    logger.info(`Constructing video URL directly from UUID: ${fullVideo.uuid}`)

    // Use PeerTube's official getFiles() API to get video file URLs
    // This returns the actual URLs with correct file UUIDs for object storage
    try {
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

    // If getFiles() didn't provide a URL, log error and return
    if (!videoPath) {
      logger.error(`Failed to get video URL for ${fullVideo.uuid} via getFiles() - video may still be processing or files unavailable`)
      return // Skip snapshot extraction but continue processing
    }

    logger.info(`Video URL ready for processing: ${videoPath}`)
  } catch (error) {
    logger.error('Error while constructing video URL:', error)
    return // Skip snapshot extraction but continue processing
  }

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
    // First, try to get captions through PeerTube's API
    let captionUrl = null
    let captionContent = null

    // Try to load full video details which might include caption information
    try {
      const videoModel = await peertubeHelpers.videos.loadByIdOrUUID(video.uuid)

      // Extract data from Sequelize model if needed
      const fullVideo = videoModel.dataValues || videoModel

      // Log the model structure for debugging
      logger.info(`Video model keys for captions: ${Object.keys(videoModel).join(', ')}`)
      if (fullVideo !== videoModel) {
        logger.info(`Video dataValues keys: ${Object.keys(fullVideo).join(', ')}`)
      }

      // Check if video has captions property
      if (fullVideo.captions || fullVideo.videoCaptions) {
        const captions = fullVideo.captions || fullVideo.videoCaptions
        logger.info(`Found ${captions.length} caption(s) for video ${video.uuid}`)

        // Prefer English, but take any available caption
        const caption = captions.find(c => c.language?.id === 'en' || c.language?.code === 'en') ||
                       captions[0]

        if (caption) {
          captionUrl = caption.captionPath || caption.fileUrl || caption.url
          logger.info(`Found caption URL: ${captionUrl}`)
        }
      }

      // Check for VideoCaptions association (Sequelize)
      if (!captionUrl && videoModel.VideoCaptions) {
        logger.info(`Found VideoCaptions association with ${videoModel.VideoCaptions.length} captions`)
        for (const caption of videoModel.VideoCaptions) {
          const captionData = caption.dataValues || caption
          logger.info(`Caption data: ${JSON.stringify(captionData)}`)

          // Try to find the caption URL
          if (captionData.fileUrl || captionData.captionPath) {
            captionUrl = captionData.fileUrl || captionData.captionPath
            logger.info(`Found caption URL from VideoCaptions: ${captionUrl}`)
            break
          }
        }
      }

      // Also check trackerUrls, which might contain caption info
      if (!captionUrl && fullVideo.trackerUrls) {
        logger.debug(`Video has tracker URLs: ${fullVideo.trackerUrls.length}`)
      }

      // Log available properties for debugging
      if (!captionUrl) {
        logger.debug(`Full video object keys: ${Object.keys(fullVideo).join(', ')}`)
      }
    } catch (error) {
      logger.debug('Could not load video captions via API:', error.message)
    }

    // Alternative: Try to get captions through PeerTube helpers
    if (!captionUrl) {
      try {
        // Try using the PeerTube database if accessible
        // This is a workaround to check if captions exist
        if (video.id) {
          logger.debug(`Checking for captions for video ID: ${video.id}`)
          // Note: Direct database access might not be available in plugins
          // Captions would need to be accessed through the loaded video object
        }
      } catch (error) {
        logger.debug('Could not check for captions:', error.message)
      }
    }

    // Try to construct caption URL from Spaces if not found
    if (!captionUrl && video.uuid) {
      // Get configured captions CDN URL and credentials
      const spacesCaptionsUrl = await settingsManager.getSetting('spaces-captions-url')
      const accessKey = await settingsManager.getSetting('spaces-access-key')
      const secretKey = await settingsManager.getSetting('spaces-secret-key')

      if (spacesCaptionsUrl) {
        // If we have credentials, always use signed URLs
        if (accessKey && secretKey) {
          captionUrl = await spacesService.getSignedCaptionUrl(video.uuid, spacesCaptionsUrl)
          logger.info(`Generated signed caption URL for video`)
        } else {
          // No credentials - use direct URL (will only work for public videos)
          captionUrl = `${spacesCaptionsUrl}/captions${video.uuid}-en.vtt`
          logger.info(`Using direct caption URL (public videos only): ${captionUrl}`)
        }
      } else {
        logger.debug('No captions CDN URL configured in settings')
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
          logger.info(`Downloaded caption from remote URL: ${captionUrl}`)
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

    logger.info(`No caption files found (local or remote) for video ${video.uuid}`)
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