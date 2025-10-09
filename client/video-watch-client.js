function register({ registerHook, peertubeHelpers }) {
  // Initialize the AI chat interface on video watch pages
  registerHook({
    target: 'action:video-watch.video.loaded',
    handler: ({ video }) => initializeAIChat(video, peertubeHelpers)
  })

  // Add process/reprocess button to video action buttons
  registerHook({
    target: 'action:video-watch.player.loaded',
    handler: ({ video }) => addProcessButton(video, peertubeHelpers)
  })
}

async function addProcessButton(video, peertubeHelpers) {
  // Wait for the action buttons to be rendered
  setTimeout(async () => {
    const actionButtons = document.querySelector('.action-dropdown')
    if (!actionButtons) return

    // Check if user has permission to process (owner or admin)
    const user = await peertubeHelpers.getUser()
    const isOwner = user && video.account && user.account.id === video.account.id
    const isAdmin = user && user.role && user.role === 0

    if (!isOwner && !isAdmin) return

    // Create process button
    const processButton = document.createElement('div')
    processButton.className = 'dropdown-item'
    processButton.innerHTML = `
      <span class="dropdown-item-icon">🤖</span>
      <span>Process with AI Chat</span>
    `

    processButton.addEventListener('click', async () => {
      processButton.style.opacity = '0.5'
      processButton.style.pointerEvents = 'none'
      processButton.innerHTML = `
        <span class="dropdown-item-icon">⏳</span>
        <span>Processing...</span>
      `

      try {
        const response = await fetch(peertubeHelpers.getBaseRouterRoute() + `/processing/trigger/${video.uuid}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...peertubeHelpers.getAuthHeader()
          }
        })

        if (response.ok) {
          peertubeHelpers.notifier.success('Video queued for AI processing')
        } else {
          throw new Error('Failed to trigger processing')
        }
      } catch (error) {
        console.error('Error triggering processing:', error)
        peertubeHelpers.notifier.error('Failed to process video')
      } finally {
        processButton.style.opacity = '1'
        processButton.style.pointerEvents = 'auto'
        processButton.innerHTML = `
          <span class="dropdown-item-icon">🤖</span>
          <span>Reprocess with AI Chat</span>
        `
      }
    })

    // Find dropdown menu and add the button
    const dropdownMenu = actionButtons.querySelector('.dropdown-menu')
    if (dropdownMenu) {
      dropdownMenu.appendChild(processButton)
    }
  }, 1000)
}

async function initializeAIChat(video, peertubeHelpers) {
  // Check if chat is enabled for this video
  const settings = await peertubeHelpers.getSettings()
  if (!settings || !settings['chat-enabled']) {
    return
  }

  // Remove existing chat if present
  const existingChat = document.getElementById('ai-chat-drawer')
  if (existingChat) {
    existingChat.remove()
  }

  // Create drawer container
  const chatDrawer = document.createElement('div')
  chatDrawer.id = 'ai-chat-drawer'
  chatDrawer.className = 'ai-chat-drawer'

  // Create toggle button (floating button to open drawer)
  const toggleButton = document.createElement('button')
  toggleButton.id = 'ai-chat-toggle-btn'
  toggleButton.className = 'ai-chat-toggle-btn'
  toggleButton.innerHTML = `
    <span class="chat-icon">💬</span>
    <span class="chat-badge" style="display:none">0</span>
  `

  // Add drawer content
  chatDrawer.innerHTML = `
    <div class="ai-chat-overlay"></div>
    <div class="ai-chat-panel">
      <div class="ai-chat-header">
        <h3>AI Assistant</h3>
        <button class="ai-chat-close" aria-label="Close chat">×</button>
      </div>
      <div class="ai-chat-body">
        <div class="ai-chat-messages" id="ai-chat-messages">
          <div class="ai-chat-welcome">
            Ask me anything about this video! I can help you understand the content,
            find specific moments, or provide additional context.
          </div>
        </div>
        <div class="ai-chat-input-container">
          <textarea
            id="ai-chat-input"
            class="ai-chat-input"
            placeholder="Ask a question about the video..."
            rows="2"
          ></textarea>
          <button id="ai-chat-send" class="ai-chat-send" aria-label="Send message">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/>
            </svg>
          </button>
        </div>
      </div>
    </div>
  `

  // Add to body for fixed positioning
  document.body.appendChild(chatDrawer)
  document.body.appendChild(toggleButton)

  // Initialize event handlers
  initializeChatHandlers(video, peertubeHelpers)

  // Check processing status
  checkProcessingStatus(video, peertubeHelpers)
}

function initializeChatHandlers(video, peertubeHelpers) {
  const input = document.getElementById('ai-chat-input')
  const sendButton = document.getElementById('ai-chat-send')
  const messagesContainer = document.getElementById('ai-chat-messages')
  const drawer = document.getElementById('ai-chat-drawer')
  const toggleButton = document.getElementById('ai-chat-toggle-btn')
  const closeButton = document.querySelector('.ai-chat-close')
  const overlay = document.querySelector('.ai-chat-overlay')

  // Open drawer
  toggleButton?.addEventListener('click', () => {
    drawer.classList.add('open')
    input?.focus()
  })

  // Close drawer
  const closeDrawer = () => {
    drawer.classList.remove('open')
  }

  closeButton?.addEventListener('click', closeDrawer)
  overlay?.addEventListener('click', closeDrawer)

  // ESC key to close
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && drawer.classList.contains('open')) {
      closeDrawer()
    }
  })

  // Send message handler
  const sendMessage = async () => {
    const message = input.value.trim()
    if (!message) return

    // Add user message to chat
    addMessageToChat('user', message)

    // Clear input
    input.value = ''
    sendButton.disabled = true
    input.disabled = true

    // Show loading indicator
    const loadingId = addMessageToChat('assistant', '...', true)

    try {
      // Send message to backend
      const response = await fetch(peertubeHelpers.getBaseRouterRoute() + '/chat/send', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...peertubeHelpers.getAuthHeader()
        },
        body: JSON.stringify({
          videoId: video.id,
          videoUuid: video.uuid,
          message: message
        })
      })

      const data = await response.json()

      // Remove loading and add response
      removeMessage(loadingId)
      addMessageToChat('assistant', data.response, false, data.timestamps)

    } catch (error) {
      console.error('Error sending message:', error)
      removeMessage(loadingId)
      addMessageToChat('assistant', 'Sorry, I encountered an error. Please try again.')
      peertubeHelpers.notifier.error('Failed to send message')
    } finally {
      sendButton.disabled = false
      input.disabled = false
      input.focus()
    }
  }

  // Event listeners
  sendButton?.addEventListener('click', sendMessage)
  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  })
}

function addMessageToChat(role, content, isLoading = false, timestamps = []) {
  const messagesContainer = document.getElementById('ai-chat-messages')
  const messageId = `msg-${Date.now()}-${Math.random()}`

  const messageDiv = document.createElement('div')
  messageDiv.className = `ai-chat-message ${role}`
  messageDiv.id = messageId

  if (isLoading) {
    messageDiv.innerHTML = `
      <div class="message-content">
        <div class="loading-dots">
          <span></span><span></span><span></span>
        </div>
      </div>
    `
  } else {
    // Process content for timestamps
    let processedContent = content
    if (timestamps && timestamps.length > 0) {
      timestamps.forEach(ts => {
        const link = `<a href="#" class="timestamp-link" data-time="${ts.seconds}">${ts.display}</a>`
        processedContent = processedContent.replace(ts.display, link)
      })
    }

    messageDiv.innerHTML = `
      <div class="message-role">${role === 'user' ? 'You' : 'AI'}</div>
      <div class="message-content">${processedContent}</div>
    `

    // Add click handlers for timestamp links
    messageDiv.querySelectorAll('.timestamp-link').forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault()
        const time = parseFloat(link.dataset.time)
        seekToTime(time)
      })
    })
  }

  messagesContainer.appendChild(messageDiv)
  messagesContainer.scrollTop = messagesContainer.scrollHeight

  return messageId
}

function removeMessage(messageId) {
  const message = document.getElementById(messageId)
  if (message) {
    message.remove()
  }
}

function seekToTime(seconds) {
  // Try to find the video player and seek to the timestamp
  const videoElement = document.querySelector('video')
  if (videoElement) {
    videoElement.currentTime = seconds
    videoElement.play()
  }
}

async function checkProcessingStatus(video, peertubeHelpers) {
  try {
    const response = await fetch(peertubeHelpers.getBaseRouterRoute() + `/processing/status/${video.uuid}`, {
      headers: {
        ...peertubeHelpers.getAuthHeader()
      }
    })

    if (response.ok) {
      const status = await response.json()

      if (status.processing) {
        // Show processing indicator
        const messagesContainer = document.getElementById('ai-chat-messages')
        if (messagesContainer) {
          const processingDiv = document.createElement('div')
          processingDiv.className = 'ai-chat-processing'
          processingDiv.innerHTML = `
            <div class="processing-icon">⚡</div>
            <div>Video is being processed for AI chat. This may take a few minutes...</div>
          `
          messagesContainer.appendChild(processingDiv)
        }
      } else if (!status.processed) {
        // Show not processed message
        const messagesContainer = document.getElementById('ai-chat-messages')
        if (messagesContainer) {
          const notProcessedDiv = document.createElement('div')
          notProcessedDiv.className = 'ai-chat-not-processed'
          notProcessedDiv.innerHTML = `
            <div class="warning-icon">⚠️</div>
            <div>This video hasn't been processed for AI chat yet. Ask the video owner to enable AI processing.</div>
          `
          messagesContainer.appendChild(notProcessedDiv)
        }
      }
    }
  } catch (error) {
    console.error('Error checking processing status:', error)
  }
}

export { register }