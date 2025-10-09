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
              if (reloadedVideo.VideoFiles && reloadedVideo.VideoFiles.length > 0) {
                fullVideo.VideoFiles = reloadedVideo.VideoFiles
                logger.info(`Added ${reloadedVideo.VideoFiles.length} VideoFiles from reload`)
              }
              if (reloadedVideo.VideoStreamingPlaylists && reloadedVideo.VideoStreamingPlaylists.length > 0) {
                fullVideo.VideoStreamingPlaylists = reloadedVideo.VideoStreamingPlaylists
                logger.info(`Added ${reloadedVideo.VideoStreamingPlaylists.length} StreamingPlaylists from reload`)
              }
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

  // Get video file path
  let videoPath
  try {
    // Now use the full video object
    logger.info(`Searching for video file URL for ${fullVideo.uuid}`)

    // Check VideoFiles from Sequelize model
    if (fullVideo.VideoFiles && fullVideo.VideoFiles.length > 0) {
      logger.info(`Checking ${fullVideo.VideoFiles.length} VideoFiles`)
      for (const file of fullVideo.VideoFiles) {
        const fileData = file.dataValues || file
        logger.info(`VideoFile data: ${JSON.stringify(fileData)}`)

        // Check for various URL properties
        // Note: fileUrl might be a signed URL for private videos
        if (fileData.fileUrl) {
          videoPath = fileData.fileUrl
          logger.info(`Found video file URL: ${videoPath}`)
          // Check if it's a signed URL
          if (videoPath.includes('X-Amz-Signature') || videoPath.includes('signature=')) {
            logger.info('URL appears to be signed/authenticated')
          }
          break
        } else if (fileData.torrentUrl) {
          // We might be able to get the actual file URL from the torrent
          logger.info(`File has torrentUrl but no direct fileUrl: ${fileData.torrentUrl}`)
        }
      }
    }

    // Check VideoStreamingPlaylists from Sequelize model
    if (!videoPath && fullVideo.VideoStreamingPlaylists && fullVideo.VideoStreamingPlaylists.length > 0) {
      logger.info(`Checking ${fullVideo.VideoStreamingPlaylists.length} VideoStreamingPlaylists`)
      for (const playlist of fullVideo.VideoStreamingPlaylists) {
        const playlistData = playlist.dataValues || playlist
        logger.info(`StreamingPlaylist data keys: ${Object.keys(playlistData).join(', ')}`)

        // Check if playlist has VideoFiles association
        if (playlist.VideoFiles && playlist.VideoFiles.length > 0) {
          logger.info(`Playlist has ${playlist.VideoFiles.length} VideoFiles`)
          for (const file of playlist.VideoFiles) {
            const fileData = file.dataValues || file
            logger.info(`Playlist VideoFile data: ${JSON.stringify(fileData)}`)

            if (fileData.fileUrl) {
              videoPath = fileData.fileUrl
              logger.info(`Found video URL in playlist files: ${videoPath}`)
              break
            }
          }
          if (videoPath) break
        }

        // Check for playlistUrl directly
        if (!videoPath && playlistData.playlistUrl) {
          videoPath = playlistData.playlistUrl
          logger.info(`Using HLS playlist URL from StreamingPlaylist: ${videoPath}`)
          break
        }

        // Check for segmentsSha256Url or other properties
        if (!videoPath && playlistData.segmentsSha256Url) {
          // Extract base URL from segments URL to construct playlist URL
          const baseUrl = playlistData.segmentsSha256Url.replace(/\/segments-sha256\.json$/, '')
          const possiblePlaylistUrl = `${baseUrl}/master.m3u8`
          logger.info(`Constructed possible playlist URL: ${possiblePlaylistUrl}`)
          videoPath = possiblePlaylistUrl
          break
        }
      }
    }

    // Try multiple approaches to find the video file if not found yet
    if (!videoPath) {
      // Approach 1: Try PeerTube helpers if available
      try {
        const videoFiles = await peertubeHelpers.videos.getFiles(video.id)
        if (videoFiles && videoFiles.length > 0) {
          logger.info(`Found ${videoFiles.length} files via getFiles helper`)
          for (const file of videoFiles) {
            logger.info(`Helper file data: ${JSON.stringify(file)}`)
            if (file.fileUrl || file.path) {
              videoPath = file.fileUrl || file.path
              logger.info(`Found video file via helpers: ${videoPath}`)
              break
            }
          }
        }
      } catch (e) {
        logger.debug('Could not get files via helpers:', e.message)
      }
    }

    // Approach 1b: Try server-side access to get complete video data
    if (!videoPath) {
      try {
        logger.info('Attempting server-side video data access')

        // Method 1: Try to use PeerTube's internal video getter if available
        if (peertubeHelpers.videos?.get) {
          const completeVideo = await peertubeHelpers.videos.get(fullVideo.id)
          if (completeVideo) {
            logger.info(`Got complete video with keys: ${Object.keys(completeVideo).join(', ')}`)

            if (completeVideo.VideoFiles && completeVideo.VideoFiles.length > 0) {
              logger.info(`Complete video has ${completeVideo.VideoFiles.length} VideoFiles`)
              const file = completeVideo.VideoFiles[0]
              const fileData = file.dataValues || file
              logger.info(`Complete video file data: ${JSON.stringify(fileData)}`)
              if (fileData.fileUrl) {
                videoPath = fileData.fileUrl
                logger.info(`Found video URL from complete video: ${videoPath}`)
              }
            }

            if (!videoPath && completeVideo.VideoStreamingPlaylists && completeVideo.VideoStreamingPlaylists.length > 0) {
              const playlist = completeVideo.VideoStreamingPlaylists[0]
              const playlistData = playlist.dataValues || playlist
              if (playlistData.playlistUrl) {
                videoPath = playlistData.playlistUrl
                logger.info(`Found playlist URL from complete video: ${videoPath}`)
              }
            }
          }
        }

        // Method 2: Try to access video files table directly if we have database access
        if (!videoPath && peertubeHelpers.database?.query) {
          logger.info('Attempting direct database query for video files')

          // Query for video files
          const fileQuery = `
            SELECT * FROM "videoFile"
            WHERE "videoId" = $1
            ORDER BY "resolution" DESC
            LIMIT 1
          `
          const fileResults = await peertubeHelpers.database.query(fileQuery, [fullVideo.id])

          if (fileResults && fileResults.length > 0) {
            const file = fileResults[0]
            logger.info(`Database file record: ${JSON.stringify(file)}`)
            if (file.fileUrl) {
              videoPath = file.fileUrl
              logger.info(`Found video URL from database: ${videoPath}`)
            }
          }

          // Query for streaming playlists if no file found
          if (!videoPath) {
            const playlistQuery = `
              SELECT * FROM "videoStreamingPlaylist"
              WHERE "videoId" = $1
              LIMIT 1
            `
            const playlistResults = await peertubeHelpers.database.query(playlistQuery, [fullVideo.id])

            if (playlistResults && playlistResults.length > 0) {
              const playlist = playlistResults[0]
              logger.info(`Database playlist record: ${JSON.stringify(playlist)}`)
              if (playlist.playlistUrl) {
                videoPath = playlist.playlistUrl
                logger.info(`Found playlist URL from database: ${videoPath}`)
              }
            }
          }
        }

        // Method 3: Check video object for URL patterns
        if (!videoPath && fullVideo.url) {
          // The video.url might contain the ActivityPub URL
          // We can try to construct the file URL from it
          logger.info(`Video has URL property: ${fullVideo.url}`)

          // If it's an ActivityPub URL, we might be able to construct file URLs
          if (fullVideo.url.includes('/videos/watch/')) {
            const baseUrl = fullVideo.url.split('/videos/watch/')[0]

            // Try common file URL patterns
            const possibleUrls = [
              `${baseUrl}/static/webseed/${fullVideo.uuid}-720.mp4`,
              `${baseUrl}/static/webseed/${fullVideo.uuid}-480.mp4`,
              `${baseUrl}/static/webseed/${fullVideo.uuid}-360.mp4`,
              `${baseUrl}/static/streaming-playlists/hls/${fullVideo.uuid}/master.m3u8`
            ]

            logger.info(`Constructed possible URLs from video.url: ${possibleUrls.join(', ')}`)

            // We'll use the first one as a guess
            videoPath = possibleUrls[0]
            logger.info(`Using constructed URL: ${videoPath}`)
          }
        }

        // Method 4: Check if video state indicates processing
        if (!videoPath && fullVideo.state) {
          logger.info(`Video state: ${fullVideo.state}`)
          if (fullVideo.state !== 1) { // 1 = published
            logger.warn(`Video is not in published state (state=${fullVideo.state}), files may not be available yet`)
          }
        }

        // Method 5: Try to generate signed URLs for any video (public or private)
        if (!videoPath) {
          logger.info('Attempting to generate signed URL for video access')

          // Get configured CDN URLs from settings
          const spacesStreamingUrl = await settingsManager.getSetting('spaces-streaming-url')
          const spacesVideosUrl = await settingsManager.getSetting('spaces-videos-url')
          const accessKey = await settingsManager.getSetting('spaces-access-key')
          const secretKey = await settingsManager.getSetting('spaces-secret-key')

          // If we have credentials, always use signed URLs for consistency
          if (accessKey && secretKey) {
            if (spacesStreamingUrl) {
              // Generate signed URL for video (works for both public and private)
              const signedUrl = await spacesService.getSignedVideoUrl(fullVideo.uuid, spacesStreamingUrl, true)
              if (signedUrl) {
                videoPath = signedUrl
                logger.info(`Generated signed URL for video: ${fullVideo.uuid}`)
              }
            } else if (spacesVideosUrl) {
              // Try regular videos URL
              const signedUrl = await spacesService.getSignedVideoUrl(fullVideo.uuid, spacesVideosUrl, false)
              if (signedUrl) {
                videoPath = signedUrl
                logger.info(`Generated signed URL for video from videos URL: ${fullVideo.uuid}`)
              }
            }

            if (!videoPath) {
              logger.warn('Could not generate signed URL - check S3/Spaces configuration')
            }
          } else {
            // No credentials - try direct URLs (will only work for public videos)
            logger.info('No S3/Spaces credentials configured - using direct URLs')

            if (spacesStreamingUrl) {
              videoPath = `${spacesStreamingUrl}/${fullVideo.uuid}-master.m3u8`
              logger.info(`Using direct URL (public videos only): ${videoPath}`)
            } else if (spacesVideosUrl) {
              videoPath = `${spacesVideosUrl}/${fullVideo.uuid}-720.mp4`
              logger.info(`Using direct video URL (public videos only): ${videoPath}`)
            }
          }
        }

        if (!videoPath) {
          // Also check environment variables as fallback
          const envBases = [
            process.env.OBJECT_STORAGE_BASE_URL,
            process.env.S3_BASE_URL,
            process.env.SPACES_BASE_URL,
            process.env.PEERTUBE_OBJECT_STORAGE_STREAMING_BASE_URL,
            process.env.PEERTUBE_OBJECT_STORAGE_VIDEOS_BASE_URL
          ].filter(Boolean)

          // Combine all possible bases (prioritize configured settings)
          const possibleBases = [...spacesBaseUrls, ...envBases]

          // If we have URL from video object, extract domain and add CDN variants
          if (fullVideo.url) {
            const urlMatch = fullVideo.url.match(/^(https?:\/\/[^\/]+)/);
            if (urlMatch) {
              const domain = urlMatch[1];
              // Common CDN/storage patterns
              possibleBases.push(
                `${domain}/static/webseed`,
                `${domain}/static/streaming-playlists/hls`,
                domain.replace('://', '://cdn.'),
                domain.replace('://', '://storage.'),
                domain.replace('://', '://files.'),
                domain.replace('peertube', 'peertube-streaming-1'),
                domain.replace('peertube', 'peertube-videos-1')
              )
            }
          }

          // Try to find a working URL based on actual Spaces structure
          for (const base of possibleBases) {
            // The actual pattern from your Spaces:
            // Master playlist: {uuid}-master.m3u8
            // Individual quality: {uuid}-720-fragmented.mp4 or {uuid}-720.m3u8
            const testUrls = [
              `${base}/${fullVideo.uuid}-master.m3u8`,  // HLS master playlist
              `${base}/${fullVideo.uuid}-720-fragmented.mp4`,  // Direct MP4
              `${base}/${fullVideo.uuid}-720.m3u8`,  // 720p playlist
              `${base}/${fullVideo.uuid}-480-fragmented.mp4`,  // 480p MP4
              `${base}/${fullVideo.uuid}-480.m3u8`,  // 480p playlist
              `${base}/${fullVideo.uuid}-360-fragmented.mp4`,  // 360p MP4
              `${base}/${fullVideo.uuid}-360.m3u8`  // 360p playlist
            ]

            logger.info(`Testing object storage URLs with base ${base}`)

            // Use the master playlist as it's most flexible for FFmpeg
            if (testUrls[0]) {
              videoPath = testUrls[0]
              logger.info(`Using constructed object storage URL: ${videoPath}`)
              break
            }
          }

          // If still no path, log appropriate warning
          if (!videoPath) {
            logger.warn(`No video URL could be constructed - please configure Spaces CDN URLs and optionally S3/Spaces credentials in plugin settings`)
          }
        }

      } catch (e) {
        logger.debug('Could not access video data server-side:', e.message)
      }
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

    // Approach 3: Check if video has streamingPlaylists (for HLS)
    if (!videoPath && fullVideo.streamingPlaylists && fullVideo.streamingPlaylists.length > 0) {
      logger.info(`Checking ${fullVideo.streamingPlaylists.length} streaming playlists`)
      const playlist = fullVideo.streamingPlaylists[0]
      if (playlist.files && playlist.files.length > 0) {
        logger.info(`Playlist has ${playlist.files.length} files`)
        // Use the first available file
        const file = playlist.files[0]
        if (file) {
          logger.info(`Playlist file keys: ${Object.keys(file).join(', ')}`)
          videoPath = file.fileUrl || file.fileDownloadUrl || file.torrentUrl
          if (videoPath) {
            logger.info(`Using streaming playlist file: ${videoPath}`)
          }
        }
      }
    }

    // Approach 4: Check for webtorrent files
    if (!videoPath && fullVideo.webtorrentFiles && fullVideo.webtorrentFiles.length > 0) {
      logger.info(`Checking ${fullVideo.webtorrentFiles.length} webtorrent files`)
      const file = fullVideo.webtorrentFiles.find(f => f.fileUrl || f.fileDownloadUrl) || fullVideo.webtorrentFiles[0]
      if (file) {
        logger.info(`Webtorrent file keys: ${Object.keys(file).join(', ')}`)
        videoPath = file.fileUrl || file.fileDownloadUrl
        if (videoPath) {
          logger.info(`Using webtorrent file: ${videoPath}`)
        }
      }
    }

    // Approach 5: Check for playlist URLs directly
    if (!videoPath && fullVideo.streamingPlaylists && fullVideo.streamingPlaylists.length > 0) {
      const playlist = fullVideo.streamingPlaylists[0]
      if (playlist.playlistUrl) {
        // For HLS, we can use the playlist URL directly
        // FFmpeg can handle m3u8 playlists
        videoPath = playlist.playlistUrl
        logger.info(`Using HLS playlist URL: ${videoPath}`)
      } else {
        logger.info(`Playlist object keys: ${Object.keys(playlist).join(', ')}`)
      }
    }

    if (!videoPath) {
      logger.warn(`No video file found (local or remote) for ${fullVideo.uuid}, skipping snapshot extraction`)
      logger.info(`Full video object keys available: ${Object.keys(fullVideo).join(', ')}`)
      return // Skip snapshot extraction but continue processing
    }
  } catch (error) {
    logger.error('Error while searching for video file:', error)
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