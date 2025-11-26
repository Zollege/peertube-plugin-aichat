const databaseService = require('./server/database-service')
const videoProcessor = require('./server/video-processor')
const openaiService = require('./server/openai-service')
const chatService = require('./server/chat-service')

let logger = null
let settingsManager = null
let storageManager = null
let peertubeHelpers = null

async function register({
  registerHook,
  registerSetting,
  settingsManager: _settingsManager,
  storageManager: _storageManager,
  videoCategoryManager,
  videoLicenceManager,
  videoLanguageManager,
  peertubeHelpers: _peertubeHelpers,
  getRouter
}) {
  // Store references
  settingsManager = _settingsManager
  storageManager = _storageManager
  peertubeHelpers = _peertubeHelpers
  logger = peertubeHelpers.logger

  // Initialize services
  const services = {
    logger,
    settingsManager,
    storageManager,
    peertubeHelpers
  }

  // Register plugin settings
  await registerSettings(registerSetting)

  // Initialize services with error handling
  try {
    await databaseService.initialize(services)
    logger.info('Database service initialized successfully')
  } catch (error) {
    logger.error('Failed to initialize database service:', error)
    // Continue with plugin load but log the error
  }

  await openaiService.initialize(services)
  videoProcessor.initialize(services)
  chatService.initialize(services)

  // Register hooks for video processing
  registerVideoHooks(registerHook)

  // Register API routes
  const router = getRouter()
  registerAPIRoutes(router)

  logger.info('AI Chat plugin registered successfully')
}

async function unregister() {
  // Disconnect from external database if connected
  await databaseService.disconnect()

  if (logger) {
    logger.info('AI Chat plugin unregistered')
  }
}

async function registerSettings(registerSetting) {
  // Database URL for pgvector
  registerSetting({
    name: 'database-url',
    label: 'PostgreSQL Database URL',
    type: 'input-password',
    descriptionHTML: 'PostgreSQL connection URL with pgvector extension (e.g., postgres://user:pass@host:5432/dbname)',
    private: true,
    default: ''
  })

  // OpenAI API Key
  registerSetting({
    name: 'openai-api-key',
    label: 'OpenAI API Key',
    type: 'input-password',
    descriptionHTML: 'Your OpenAI API key for GPT-4 and embeddings',
    private: true,
    default: ''
  })

  // Enable/Disable chat
  registerSetting({
    name: 'chat-enabled',
    label: 'Enable AI Chat',
    type: 'input-checkbox',
    descriptionHTML: 'Enable AI chat for videos',
    private: false,
    default: true
  })

  // Auto-process videos
  registerSetting({
    name: 'auto-process',
    label: 'Auto-process new videos',
    type: 'input-checkbox',
    descriptionHTML: 'Automatically process new videos when uploaded',
    private: false,
    default: true
  })

  // Model selection (ordered by cost efficiency for vision)
  registerSetting({
    name: 'openai-model',
    label: 'OpenAI Model',
    type: 'select',
    options: [
      { label: 'GPT-4.1-nano (Most cost-efficient)', value: 'gpt-4.1-nano' },
      { label: 'GPT-4.1-mini (Very cost-efficient)', value: 'gpt-4.1-mini' },
      { label: 'GPT-4o-mini (Legacy mini)', value: 'gpt-4o-mini' },
      { label: 'GPT-4.1 (Latest balanced)', value: 'gpt-4.1' },
      { label: 'GPT-4o (Legacy balanced)', value: 'gpt-4o' },
      { label: 'GPT-4 Turbo', value: 'gpt-4-turbo' },
      { label: 'GPT-4', value: 'gpt-4' }
    ],
    descriptionHTML: 'Which OpenAI model to use for chat and vision (ordered by cost efficiency)',
    private: false,
    default: 'gpt-4.1-mini'
  })

  // Snapshot interval
  registerSetting({
    name: 'snapshot-interval',
    label: 'Snapshot Interval (seconds)',
    type: 'input',
    descriptionHTML: 'Interval between video snapshots in seconds (minimum: 1, maximum: 60)',
    private: false,
    default: '5'
  })

  // Max tokens
  registerSetting({
    name: 'max-tokens',
    label: 'Max Response Tokens',
    type: 'input',
    descriptionHTML: 'Maximum tokens for AI responses',
    private: false,
    default: '1000'
  })

  // System prompt
  registerSetting({
    name: 'system-prompt',
    label: 'System Prompt',
    type: 'input-textarea',
    descriptionHTML: 'Custom system prompt for the AI',
    private: false,
    default: `You are an AI assistant helping users understand and discuss videos on this platform.

You have access to:
1. The CURRENT VIDEO's title, description, channel, duration, and transcript
2. Visual descriptions from video snapshots at various timestamps
3. A list of OTHER AVAILABLE VIDEOS you can recommend

Guidelines:
- When users ask about "this video" or "the video", refer to the CURRENT VIDEO information
- Reference specific timestamps [MM:SS] when discussing video content from the transcript
- When asked for recommendations or related content, suggest videos from the OTHER AVAILABLE VIDEOS list
- Remember the conversation history to provide coherent follow-up responses
- Be concise but informative
- If you don't have enough information to answer, say so honestly`
  })

  // S3/Spaces Access Credentials (for private videos if needed)
  registerSetting({
    name: 'spaces-access-key',
    label: 'Spaces/S3 Access Key ID',
    type: 'input-password',
    descriptionHTML: 'Access Key ID for DigitalOcean Spaces or S3 (may be required for private videos)',
    private: true,
    default: ''
  })

  registerSetting({
    name: 'spaces-secret-key',
    label: 'Spaces/S3 Secret Access Key',
    type: 'input-password',
    descriptionHTML: 'Secret Access Key for DigitalOcean Spaces or S3 (may be required for private videos)',
    private: true,
    default: ''
  })

  registerSetting({
    name: 'spaces-region',
    label: 'Spaces/S3 Region',
    type: 'input',
    descriptionHTML: 'Region for DigitalOcean Spaces or S3 (e.g., nyc3, us-east-1)',
    private: false,
    default: 'nyc3'
  })
}

function registerVideoHooks(registerHook) {
  // Hook into video upload/publish events
  registerHook({
    target: 'action:api.video.uploaded',
    handler: async ({ video }) => {
      const autoProcess = await settingsManager.getSetting('auto-process')
      if (autoProcess) {
        await videoProcessor.queueVideoForProcessing(video)
      }
    }
  })

  registerHook({
    target: 'action:api.video.updated',
    handler: async ({ video }) => {
      // Check if video was previously failed/pending and is now ready
      const status = await videoProcessor.getProcessingStatus(video.uuid)

      if (status?.status === 'error' || status?.status === 'pending') {
        const fullVideo = await peertubeHelpers.videos.loadByIdOrUUID(video.uuid)
        if (videoProcessor.isVideoReady(fullVideo)) {
          logger.info(`Video ${video.uuid} is now ready, retrying processing`)
          await videoProcessor.queueVideoForProcessing(video)
          return
        }
      }

      // Check if video has transcription available
      await videoProcessor.checkAndProcessTranscript(video)
    }
  })

  // Hook into caption creation - this is when auto-generated transcripts are ready
  registerHook({
    target: 'action:api.video-caption.created',
    handler: async ({ caption, video }) => {
      logger.info(`Caption created for video ${video?.uuid}: language=${caption?.language}`)
      if (video) {
        // Process transcript now that caption is available
        await videoProcessor.checkAndProcessTranscript(video)
      }
    }
  })

  // Clean up when video is deleted
  registerHook({
    target: 'action:api.video.deleted',
    handler: async ({ video }) => {
      await videoProcessor.cleanupVideoData(video)
    }
  })
}

function registerAPIRoutes(router) {
  // Chat endpoint
  router.post('/chat/send', async (req, res) => {
    try {
      const user = await peertubeHelpers.user.getAuthUser(res)
      const { videoId, videoUuid, message } = req.body

      const response = await chatService.handleChatMessage(
        videoId,
        videoUuid,
        message,
        user?.id
      )

      res.json(response)
    } catch (error) {
      logger.error('Chat error:', error)
      res.status(500).json({ error: 'Failed to process chat message' })
    }
  })

  // Get chat history
  router.get('/chat/history/:videoId', async (req, res) => {
    try {
      const user = await peertubeHelpers.user.getAuthUser(res)
      const { videoId } = req.params

      const history = await chatService.getChatHistory(videoId, user?.id)
      res.json(history)
    } catch (error) {
      logger.error('Failed to get chat history:', error)
      res.status(500).json({ error: 'Failed to get chat history' })
    }
  })

  // Processing status
  router.get('/processing/status/:videoUuid', async (req, res) => {
    try {
      const { videoUuid } = req.params
      const status = await videoProcessor.getProcessingStatus(videoUuid)
      res.json(status)
    } catch (error) {
      logger.error('Failed to get processing status:', error)
      res.status(500).json({ error: 'Failed to get processing status' })
    }
  })

  // Manual processing trigger
  router.post('/processing/trigger/:videoUuid', async (req, res) => {
    try {
      const user = await peertubeHelpers.user.getAuthUser(res)
      if (!user || user.role !== 0) {
        return res.status(403).json({ error: 'Admin access required' })
      }

      const { videoUuid } = req.params
      const video = await peertubeHelpers.videos.loadByIdOrUUID(videoUuid)

      if (!video) {
        return res.status(404).json({ error: 'Video not found' })
      }

      await videoProcessor.queueVideoForProcessing(video)
      res.json({ message: 'Video queued for processing' })
    } catch (error) {
      logger.error('Failed to trigger processing:', error)
      res.status(500).json({ error: 'Failed to trigger processing' })
    }
  })
}

module.exports = {
  register,
  unregister
}