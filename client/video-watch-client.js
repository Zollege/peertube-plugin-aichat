function register({ registerHook, peertubeHelpers }) {
  // Initialize the AI chat interface on video watch pages
  registerHook({
    target: 'action:video-watch.video.loaded',
    handler: ({ video }) => {
      initializeAIChat(video, peertubeHelpers)
      // Add process button after a delay to ensure DOM is ready
      setTimeout(() => addProcessButton(video, peertubeHelpers), 2000)
    }
  })
}

async function addProcessButton(video, peertubeHelpers) {
  console.log('[AI Chat] Looking for video action menu...')
  console.log('[AI Chat] Video data:', video)

  const user = await peertubeHelpers.getUser()
  if (!user) {
    console.log('[AI Chat] No user logged in, skipping process button')
    return
  }

  console.log('[AI Chat] User data:', user)
  console.log('[AI Chat] User role:', user.role)
  console.log('[AI Chat] User ID:', user.id)
  console.log('[AI Chat] Video account:', video.account)

  // Check if admin (role 0 = admin, 1 = moderator, 2 = user)
  const isAdmin = user.role === 0 || user.role === 1 // Admin or Moderator

  // Check if owner - compare various possible ID fields
  const isOwner = video.account && (
    (user.account && user.account.id === video.account.id) ||
    (user.account && user.account.name === video.account.name) ||
    (user.username === video.account.name) ||
    (user.id === video.account.userId)
  )

  console.log('[AI Chat] Is admin?', isAdmin)
  console.log('[AI Chat] Is owner?', isOwner)

  // For now, let's allow all logged-in users to see the button for testing
  // You can uncomment the restriction later
  /*
  if (!isOwner && !isAdmin) {
    console.log('[AI Chat] User is not owner or admin, skipping process button')
    return
  }
  */

  console.log('[AI Chat] User has permission, adding process button...')

  // Poll for the action dropdown button with multiple possible selectors
  let attempts = 0
  const maxAttempts = 30 // Increase attempts

  const checkForDropdown = setInterval(() => {
    attempts++
    console.log(`[AI Chat] Attempt ${attempts} to find dropdown...`)

    // Try multiple selectors for the dropdown button - PeerTube v5+ uses my-action-dropdown
    const dropdownButton = document.querySelector('my-action-dropdown .action-button-more') ||
                          document.querySelector('.action-dropdown .dropdown-toggle') ||
                          document.querySelector('[title="More actions"]') ||
                          document.querySelector('.video-actions my-action-dropdown button') ||
                          document.querySelector('.action-button-more') ||
                          document.querySelector('my-video-actions-dropdown button')

    if (dropdownButton) {
      console.log('[AI Chat] Found dropdown button:', dropdownButton)
      clearInterval(checkForDropdown)

      // Add click listener to inject our button when dropdown opens
      dropdownButton.addEventListener('click', () => {
        console.log('[AI Chat] Dropdown clicked, waiting for menu...')

        setTimeout(() => {
          // Find the dropdown menu
          const dropdownMenu = document.querySelector('.dropdown-menu.show') ||
                              document.querySelector('.dropdown-menu[aria-expanded="true"]') ||
                              document.querySelector('.video-actions .dropdown-menu')

          if (dropdownMenu && !dropdownMenu.querySelector('.ai-chat-process-btn')) {
            console.log('[AI Chat] Adding process button to menu')

            // Create process button
            const processItem = document.createElement('a')
            processItem.className = 'dropdown-item ai-chat-process-btn'
            processItem.href = '#'
            processItem.innerHTML = `
              <span style="margin-right: 8px;">🤖</span>
              <span>Process with AI Chat</span>
            `

            processItem.addEventListener('click', async (e) => {
              e.preventDefault()
              e.stopPropagation()

              processItem.style.opacity = '0.5'
              processItem.style.pointerEvents = 'none'
              processItem.innerHTML = `
                <span style="margin-right: 8px;">⏳</span>
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
                console.error('[AI Chat] Error triggering processing:', error)
                peertubeHelpers.notifier.error('Failed to process video')
              } finally {
                processItem.style.opacity = '1'
                processItem.style.pointerEvents = ''
                processItem.innerHTML = `
                  <span style="margin-right: 8px;">🤖</span>
                  <span>Reprocess with AI Chat</span>
                `
              }
            })

            // Add separator if there are existing items
            const existingItems = dropdownMenu.querySelectorAll('.dropdown-item')
            if (existingItems.length > 0) {
              const separator = document.createElement('div')
              separator.className = 'dropdown-divider'
              dropdownMenu.appendChild(separator)
            }

            // Add the process button
            dropdownMenu.appendChild(processItem)
          }
        }, 200) // Small delay for dropdown to fully render
      })
    } else if (attempts >= maxAttempts) {
      console.log('[AI Chat] Could not find dropdown button after', maxAttempts, 'attempts')
      clearInterval(checkForDropdown)
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
  const existingContainer = document.getElementById('ai-chat-floating-container')
  const existingToggle = document.getElementById('ai-chat-toggle-btn')
  if (existingContainer) existingContainer.remove()
  if (existingToggle) existingToggle.remove()

  // Create floating container
  const floatingContainer = document.createElement('div')
  floatingContainer.id = 'ai-chat-floating-container'
  floatingContainer.className = 'ai-chat-floating-container'
  floatingContainer.style.display = 'none' // Start hidden

  // Build the chat interface
  floatingContainer.innerHTML = `
    <div class="ai-chat-header">
      <h3>AI Assistant</h3>
      <button class="ai-chat-close" aria-label="Close chat">
        <span>×</span>
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

  // Create floating toggle button
  const toggleButton = document.createElement('button')
  toggleButton.id = 'ai-chat-toggle-btn'
  toggleButton.className = 'ai-chat-toggle-btn'
  toggleButton.innerHTML = `
    <span class="chat-icon">💬</span>
  `

  // Add to body for floating positioning
  document.body.appendChild(floatingContainer)
  document.body.appendChild(toggleButton)

  // Initialize event handlers
  initializeChatHandlers(video, peertubeHelpers)

  // Check processing status
  checkProcessingStatus(video, peertubeHelpers)
}

function initializeChatHandlers(video, peertubeHelpers) {
  const input = document.getElementById('ai-chat-input')
  const sendButton = document.getElementById('ai-chat-send')
  const floatingContainer = document.getElementById('ai-chat-floating-container')
  const toggleButton = document.getElementById('ai-chat-toggle-btn')
  const closeButton = document.querySelector('.ai-chat-close')

  // Toggle chat visibility
  const openChat = () => {
    floatingContainer.style.display = 'flex'
    toggleButton.style.display = 'none'
    input?.focus()
  }

  const closeChat = () => {
    floatingContainer.style.display = 'none'
    toggleButton.style.display = 'flex'
  }

  toggleButton?.addEventListener('click', openChat)
  closeButton?.addEventListener('click', closeChat)

  // ESC key to close
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && floatingContainer.style.display === 'flex') {
      closeChat()
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