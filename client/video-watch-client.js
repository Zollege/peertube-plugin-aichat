function register({ registerHook, peertubeHelpers }) {
  // Initialize the AI chat interface on video watch pages
  registerHook({
    target: 'action:video-watch.video.loaded',
    handler: ({ video }) => {
      initializeAIChat(video, peertubeHelpers)
      addProcessButton(video, peertubeHelpers)
    }
  })
}

async function addProcessButton(video, peertubeHelpers) {
  // Use PeerTube's registerVideoField to add action button
  const user = await peertubeHelpers.getUser()
  const isOwner = user && video.account && user.account.id === video.account.id
  const isAdmin = user && user.role && user.role === 0

  if (!isOwner && !isAdmin) return

  // Poll for the action dropdown button
  let attempts = 0
  const maxAttempts = 20

  const checkForDropdown = setInterval(() => {
    attempts++

    // Look for the action button (three dots menu)
    const actionDropdown = document.querySelector('.video-actions .action-button-more')

    if (actionDropdown || attempts >= maxAttempts) {
      clearInterval(checkForDropdown)

      if (actionDropdown) {
        // Find the dropdown menu container
        const dropdownContainer = actionDropdown.closest('.dropdown')

        if (dropdownContainer) {
          // Listen for when dropdown is opened
          actionDropdown.addEventListener('click', () => {
            setTimeout(() => {
              const dropdownMenu = dropdownContainer.querySelector('.dropdown-menu')

              // Check if we already added the button
              if (dropdownMenu && !dropdownMenu.querySelector('.ai-chat-process-btn')) {
                // Create process button matching PeerTube's style
                const processItem = document.createElement('a')
                processItem.className = 'dropdown-item ai-chat-process-btn'
                processItem.href = '#'
                processItem.innerHTML = `
                  <my-global-icon iconname="refresh" aria-hidden="true"></my-global-icon>
                  <span>Process with AI Chat</span>
                `

                processItem.addEventListener('click', async (e) => {
                  e.preventDefault()
                  e.stopPropagation()

                  // Update button to show processing
                  processItem.classList.add('disabled')
                  processItem.style.pointerEvents = 'none'
                  processItem.innerHTML = `
                    <my-global-icon iconname="loader" aria-hidden="true"></my-global-icon>
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
                    // Reset button
                    processItem.classList.remove('disabled')
                    processItem.style.pointerEvents = ''
                    processItem.innerHTML = `
                      <my-global-icon iconname="refresh" aria-hidden="true"></my-global-icon>
                      <span>Reprocess with AI Chat</span>
                    `
                  }
                })

                // Add separator if needed
                const existingItems = dropdownMenu.querySelectorAll('.dropdown-item')
                if (existingItems.length > 0) {
                  const separator = document.createElement('div')
                  separator.className = 'dropdown-divider'
                  dropdownMenu.appendChild(separator)
                }

                // Add the process button
                dropdownMenu.appendChild(processItem)
              }
            }, 100)
          })
        }
      }
    }
  }, 500)
}

async function initializeAIChat(video, peertubeHelpers) {
  // Check if chat is enabled for this video
  const settings = await peertubeHelpers.getSettings()
  if (!settings || !settings['chat-enabled']) {
    return
  }

  // Remove existing chat if present
  const existingChat = document.getElementById('ai-chat-container')
  const existingToggle = document.getElementById('ai-chat-toggle-btn')
  if (existingChat) existingChat.remove()
  if (existingToggle) existingToggle.remove()

  // Create chat container that sits beside the video
  const chatContainer = document.createElement('div')
  chatContainer.id = 'ai-chat-container'
  chatContainer.className = 'ai-chat-container'

  // Build the chat interface
  chatContainer.innerHTML = `
    <div class="ai-chat-header">
      <h3>AI Assistant</h3>
      <button class="ai-chat-minimize" aria-label="Minimize chat">
        <span>−</span>
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
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/>
          </svg>
        </button>
      </div>
    </div>
  `

  // Create minimized button
  const toggleButton = document.createElement('button')
  toggleButton.id = 'ai-chat-toggle-btn'
  toggleButton.className = 'ai-chat-toggle-btn'
  toggleButton.innerHTML = `
    <span class="chat-icon">💬</span>
    <span class="chat-text">AI Chat</span>
  `
  toggleButton.style.display = 'none'

  // Find the video wrapper and add chat beside it
  const mainRow = document.querySelector('.main-row')
  const videoCol = document.querySelector('.main-col')

  if (mainRow && videoCol) {
    // Create a new column for the chat
    const chatCol = document.createElement('div')
    chatCol.className = 'ai-chat-col'
    chatCol.appendChild(chatContainer)
    chatCol.appendChild(toggleButton)

    // Add the chat column after the video column
    videoCol.parentNode.insertBefore(chatCol, videoCol.nextSibling)
  } else {
    // Fallback: add below video info if structure is different
    const videoInfo = document.querySelector('.video-info')
    if (videoInfo) {
      videoInfo.parentNode.insertBefore(chatContainer, videoInfo.nextSibling)
      videoInfo.parentNode.insertBefore(toggleButton, videoInfo.nextSibling)
    }
  }

  // Initialize event handlers
  initializeChatHandlers(video, peertubeHelpers)

  // Check processing status
  checkProcessingStatus(video, peertubeHelpers)
}

function initializeChatHandlers(video, peertubeHelpers) {
  const input = document.getElementById('ai-chat-input')
  const sendButton = document.getElementById('ai-chat-send')
  const messagesContainer = document.getElementById('ai-chat-messages')
  const chatContainer = document.getElementById('ai-chat-container')
  const toggleButton = document.getElementById('ai-chat-toggle-btn')
  const minimizeButton = document.querySelector('.ai-chat-minimize')

  // Minimize/maximize chat
  const minimizeChat = () => {
    chatContainer.style.display = 'none'
    toggleButton.style.display = 'flex'
  }

  const maximizeChat = () => {
    chatContainer.style.display = 'flex'
    toggleButton.style.display = 'none'
    input?.focus()
  }

  minimizeButton?.addEventListener('click', minimizeChat)
  toggleButton?.addEventListener('click', maximizeChat)

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