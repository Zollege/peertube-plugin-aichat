function register({ registerHook, peertubeHelpers }) {
  // Initialize the AI chat interface on video watch pages
  registerHook({
    target: 'action:video-watch.video.loaded',
    handler: ({ video }) => initializeAIChat(video, peertubeHelpers)
  })
}

async function initializeAIChat(video, peertubeHelpers) {
  // Check if chat is enabled for this video
  const settings = await peertubeHelpers.getSettings()
  if (!settings || !settings['chat-enabled']) {
    return
  }

  // Create chat container
  const chatContainer = document.createElement('div')
  chatContainer.id = 'ai-chat-container'
  chatContainer.className = 'ai-chat-container'

  // Add chat UI elements
  chatContainer.innerHTML = `
    <div class="ai-chat-header">
      <h3>AI Assistant</h3>
      <button class="ai-chat-toggle" aria-label="Toggle chat">
        <span class="toggle-icon">▼</span>
      </button>
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
          <span>Send</span>
        </button>
      </div>
    </div>
  `

  // Find the right place to insert the chat
  const videoWrapper = document.querySelector('.video-info')
  if (videoWrapper) {
    videoWrapper.parentNode.insertBefore(chatContainer, videoWrapper.nextSibling)
  }

  // Initialize event handlers
  initializeChatHandlers(video, peertubeHelpers)
}

function initializeChatHandlers(video, peertubeHelpers) {
  const input = document.getElementById('ai-chat-input')
  const sendButton = document.getElementById('ai-chat-send')
  const messagesContainer = document.getElementById('ai-chat-messages')
  const toggleButton = document.querySelector('.ai-chat-toggle')
  const chatBody = document.querySelector('.ai-chat-body')

  // Toggle chat visibility
  toggleButton?.addEventListener('click', () => {
    chatBody.classList.toggle('collapsed')
    const icon = toggleButton.querySelector('.toggle-icon')
    icon.textContent = chatBody.classList.contains('collapsed') ? '▲' : '▼'
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

export { register }