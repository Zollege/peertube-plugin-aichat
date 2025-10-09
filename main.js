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
  if (logger) {
    logger.info('AI Chat plugin unregistered')
  }
}

async function registerSettings(registerSetting) {
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
    default: `You are a helpful AI assistant for PeerTube videos. You have access to the video's transcript,
snapshots, and metadata. When answering questions, reference specific timestamps when relevant.
Be concise but informative. If you mention a specific moment, include the timestamp in format [0:00].`
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
      // Check if video has transcription available
      await videoProcessor.checkAndProcessTranscript(video)
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